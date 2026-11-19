import { Worker } from "bullmq";
import { loadCatalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { deliverOutbox } from "./dialog/deliver.js";
import { processRawUpdate } from "./dialog/process.js";
import { loadScenario } from "./engine/scenario.js";
import { loadDotEnv } from "./env.js";
import { MaxClient } from "./max/client.js";
import {
  JOB_SWEEP,
  QUEUE_OUTBOX,
  QUEUE_UPDATES,
  createOutboxQueue,
  enqueueOutboxDelivery,
  type OutboxJobData,
  type UpdateJobData,
} from "./queue.js";
import { createStore } from "./store/index.js";
import { createRedis } from "./store/redis.js";

// Воркер: разбирает входящие события (updates) и доставляет исходящие
// сообщения (outbox). Два независимых BullMQ-воркера на своём соединении
// плюс периодическая «подметающая» задача — страховка на случай, если
// событие outbox не пришло.

loadDotEnv();
const config = loadConfig();

if (!config.DATABASE_URL || !config.REDIS_URL || !config.MAX_BOT_TOKEN) {
  console.error("Воркеру нужны DATABASE_URL, REDIS_URL и MAX_BOT_TOKEN (см. .env.example).");
  process.exit(1);
}

const catalog = loadCatalog(config.CATALOG_PATH);
const scenario = loadScenario(config.SCENARIO_PATH, catalog);

const pool = createPool(config.DATABASE_URL);
const store = createStore(pool);

// Сессии ссылаются на (code, version) сценария по внешнему ключу — строку
// нужно зарегистрировать до первого события.
await store.scenarios.register(scenario);

const max = new MaxClient({ token: config.MAX_BOT_TOKEN, baseUrl: config.MAX_API_BASE });

const producerRedis = createRedis(config.REDIS_URL);
const updatesRedis = createRedis(config.REDIS_URL);
const outboxRedis = createRedis(config.REDIS_URL);

const outboxQueue = createOutboxQueue(producerRedis);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCallbackId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const callback = (payload as { callback?: unknown }).callback;
  if (typeof callback !== "object" || callback === null) return undefined;
  const id = (callback as { callback_id?: unknown }).callback_id;
  return typeof id === "string" ? id : undefined;
}

// Ответ на нажатие кнопки останавливает индикатор ожидания в MAX. Ошибку не
// считаем фатальной: экран пользователь уже получит через outbox.
async function answerCallback(payload: unknown): Promise<void> {
  const callbackId = readCallbackId(payload);
  if (!callbackId) return;
  try {
    await max.answerCallback({ callbackId });
  } catch {
    // ничего не делаем: необязательный шаг
  }
}

const updatesWorker = new Worker<UpdateJobData>(
  QUEUE_UPDATES,
  async (job) => {
    const raw = await store.rawUpdates.get(job.data.rawUpdateId);
    if (!raw || raw.status !== "new") return;

    if (raw.updateType === "message_callback") await answerCallback(raw.payload);

    try {
      const result = await processRawUpdate({ store, scenario, catalog }, raw);
      const status = result.status === "done" ? "done" : result.status === "skipped" ? "skipped" : "failed";
      await store.rawUpdates.markProcessed(raw.id, status, result.reason);
      if (result.status === "done") await enqueueOutboxDelivery(outboxQueue, "update");
    } catch (error) {
      await store.rawUpdates.markProcessed(raw.id, "failed", describe(error));
      throw error;
    }
  },
  { connection: updatesRedis, concurrency: config.WORKER_CONCURRENCY },
);

const outboxWorker = new Worker<OutboxJobData>(
  QUEUE_OUTBOX,
  async () => {
    // Вычерпываем очередь пачками: одна задача не должна оставлять хвост,
    // если накопилось больше лимита пачки.
    const limit = 20;
    for (let batch = 0; batch < 10; batch += 1) {
      const result = await deliverOutbox({ outbox: store.outbox, max, limit });
      if (result.sent + result.failed < limit) break;
    }
  },
  { connection: outboxRedis },
);

updatesWorker.on("failed", (job, error) => {
  console.error(`updates: задание ${job?.id ?? "?"} упало: ${describe(error)}`);
});
outboxWorker.on("failed", (job, error) => {
  console.error(`outbox: задание ${job?.id ?? "?"} упало: ${describe(error)}`);
});

// Периодическая доставка накопившихся заданий outbox.
await outboxQueue.upsertJobScheduler(
  "outbox-sweep",
  { every: config.OUTBOX_SWEEP_MS },
  { name: JOB_SWEEP, data: { reason: "sweep" }, opts: { removeOnComplete: true, removeOnFail: 100 } },
);

console.log(`Воркер запущен: сценарий ${scenario.code} v${scenario.version}, конкурентность ${config.WORKER_CONCURRENCY}`);

async function shutdown(signal: string): Promise<void> {
  console.log(`остановка по ${signal}`);
  await updatesWorker.close();
  await outboxWorker.close();
  await outboxQueue.close();
  await Promise.all([producerRedis.quit(), updatesRedis.quit(), outboxRedis.quit()]);
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}
