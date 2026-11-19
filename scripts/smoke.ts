#!/usr/bin/env node
// Смоук-тест сквозного пути против ЖИВЫХ Postgres и Redis, но БЕЗ сети MAX:
// доставка идёт в подменный клиент. Проверяет то, чего не покрывают обычные
// тесты (они работают без БД): реальные SQL-запросы хранилища, дедупликацию,
// оптимистичную блокировку и локи Redis.
//
//   npm run check:db
//
// Нужны DATABASE_URL и (по желанию) REDIS_URL — например, поднятые через
// `docker compose up -d postgres redis`. Данные после прогона удаляются.

import type { Message, Update } from "@maxhub/max-bot-api/types";
import { loadCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { deliverOutbox } from "../src/dialog/deliver.js";
import { processRawUpdate } from "../src/dialog/process.js";
import { loadScenario } from "../src/engine/scenario.js";
import { loadDotEnv } from "../src/env.js";
import type { MaxClient } from "../src/max/client.js";
import { createRedis, acquireLock, releaseLock } from "../src/store/redis.js";
import { createStore } from "../src/store/index.js";
import { parseUpdate } from "../src/updates.js";

loadDotEnv();
const config = loadConfig();

if (!config.DATABASE_URL) {
  console.error("Нужен DATABASE_URL (см. .env.example).");
  process.exit(1);
}

const catalog = loadCatalog(config.CATALOG_PATH);
const scenario = loadScenario(config.SCENARIO_PATH);
const pool = createPool(config.DATABASE_URL);
const store = createStore(pool);

// Уникальные id на прогон — чтобы не задеть данные других тестов.
const run = Date.now();
const chatId = 9_000_000_000 + (run % 1_000_000);
const userId = 8_000_000_000 + (run % 1_000_000);

const sent: string[] = [];
const max: Pick<MaxClient, "sendMessage" | "editMessage"> = {
  async sendMessage(params): Promise<Message> {
    sent.push(params.text);
    return { body: { mid: `smoke-${sent.length}` } } as unknown as Message;
  },
  async editMessage(): Promise<void> {
    /* правок в этом сценарии нет */
  },
};

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`ПРОВАЛ: ${label}`);
  console.log(`  ok  ${label}`);
}

const started = {
  update_type: "bot_started",
  timestamp: Math.floor(run / 1000),
  chat_id: chatId,
  user: { user_id: userId },
  payload: null,
} as unknown as Update;

// Тот же путь, что в webhook + воркере: дедуп → обработка → доставка.
async function pipe(update: Update): Promise<"duplicate" | "done" | "skipped"> {
  const parsed = parseUpdate(update, run);
  const inserted = await store.rawUpdates.insert({
    dedupeKey: parsed.dedupeKey,
    updateType: parsed.updateType,
    chatId: parsed.chatId,
    userId: parsed.userId,
    payload: update,
    late: parsed.late,
  });
  if (inserted.duplicate || !inserted.id) return "duplicate";

  const raw = await store.rawUpdates.get(inserted.id);
  if (!raw) return "skipped";

  const result = await processRawUpdate({ store, scenario, catalog }, raw);
  await store.rawUpdates.markProcessed(raw.id, result.status === "done" ? "done" : "skipped", result.reason);
  if (result.status === "done") await deliverOutbox({ outbox: store.outbox, max });
  return result.status === "done" ? "done" : "skipped";
}

async function cleanup(): Promise<void> {
  await pool.query(
    `delete from answers where session_id in (
       select id from sessions where user_id in (select id from users where max_user_id = $1))`,
    [userId],
  );
  await pool.query("delete from outbox where chat_id = $1", [chatId]);
  await pool.query(
    "delete from sessions where user_id in (select id from users where max_user_id = $1)",
    [userId],
  );
  await pool.query("delete from raw_updates where chat_id = $1", [chatId]);
  await pool.query("delete from users where max_user_id = $1", [userId]);
}

console.log(`Смоук-тест: сценарий ${scenario.code} v${scenario.version}, chat ${chatId}\n`);

try {
  await store.scenarios.register(scenario);
  console.log("Диалог:");
  check((await pipe(started)) === "done", "bot_started обработан, инструкция отправлена");
  check(sent.length > 1, "инструкция отправлена несколькими сообщениями");

  const joined = sent.join("\n");
  check(joined.includes("Как получить документы"), "есть заголовок инструкции");
  check(joined.includes("Всего документов"), "указано число документов");
  check(joined.includes("может понадобиться"), "редкие документы помечены");

  check((await pipe(started)) === "duplicate", "повторное событие дедуплицировано (не дубль)");

  if (config.REDIS_URL) {
    console.log("\nRedis:");
    const redis = createRedis(config.REDIS_URL);
    const key = `smoke:${run}`;
    check(await acquireLock(redis, key, 5_000), "лок захвачен");
    check(!(await acquireLock(redis, key, 5_000)), "повторный захват отклонён");
    await releaseLock(redis, key);
    check(await acquireLock(redis, key, 5_000), "после снятия лок снова свободен");
    await releaseLock(redis, key);
    await redis.quit();
  }

  console.log(`\nИтог: путь webhook → движок → outbox → MAX работает на живой БД.`);
} finally {
  await cleanup();
  await pool.end();
}
