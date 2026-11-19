import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { loadDotEnv } from "./env.js";
import { createUpdatesQueue, enqueueUpdate } from "./queue.js";
import { createStore } from "./store/index.js";
import { createRedis } from "./store/redis.js";

// HTTP-процесс: принимает webhook MAX, пишет событие в Postgres и ставит
// задачу в Redis. Тяжёлая обработка и отправка — в воркере (src/worker.ts).

loadDotEnv();
const config = loadConfig();

if (!config.DATABASE_URL || !config.REDIS_URL) {
  console.error(
    "Нужны DATABASE_URL и REDIS_URL. Для локального запуска: docker compose up -d postgres redis",
  );
  process.exit(1);
}

const pool = createPool(config.DATABASE_URL);
const store = createStore(pool);
const redis = createRedis(config.REDIS_URL);
const updatesQueue = createUpdatesQueue(redis);

const app = buildApp({
  config,
  rawUpdates: store.rawUpdates,
  enqueueUpdate: (id) => enqueueUpdate(updatesQueue, id),
});

async function shutdown(signal: string): Promise<void> {
  app.log.info(`остановка по ${signal}`);
  await app.close();
  await updatesQueue.close();
  await redis.quit();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
