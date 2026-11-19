#!/usr/bin/env node
// Локальный запуск бота через long polling MAX: публичный webhook не нужен,
// Postgres и Redis не нужны — состояние держится в памяти. Достаточно токена.
//
//   npm run poll
//
// Логика та же, что в бою: то же событие разбирается `parseUpdate`, тот же
// движок (`processRawUpdate`) и та же доставка (`deliverOutbox`). Отличается
// только источник событий (getUpdates вместо webhook) и хранилище (память).
// Боевой режим — server + worker (webhook + Postgres/Redis).

import { loadCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { deliverOutbox } from "../src/dialog/deliver.js";
import { processRawUpdate } from "../src/dialog/process.js";
import { loadScenario } from "../src/engine/scenario.js";
import { loadDotEnv } from "../src/env.js";
import { MaxClient } from "../src/max/client.js";
import { createMemoryStore } from "../src/store/memory.js";
import { isUpdateLike, parseUpdate } from "../src/updates.js";

loadDotEnv();
const config = loadConfig();

if (!config.MAX_BOT_TOKEN) {
  console.error("Нужен MAX_BOT_TOKEN (см. .env.example).");
  process.exit(1);
}

const catalog = loadCatalog(config.CATALOG_PATH);
const scenario = loadScenario(config.SCENARIO_PATH, catalog);
const store = createMemoryStore();

// Таймаут транспорта должен быть больше времени long polling, иначе мы будем
// рвать соединение раньше, чем MAX отдаст событие.
const max = new MaxClient({
  token: config.MAX_BOT_TOKEN,
  baseUrl: config.MAX_API_BASE,
  retry: { timeoutMs: 40_000 },
});

const me = await max.getMe();
console.log(`Бот: ${me.first_name}${me.username ? ` (@${me.username})` : ""}, id ${me.user_id}`);
console.log(`Сценарий: ${scenario.title} (${scenario.code} v${scenario.version})`);
console.log(`Каталог: ${catalog.documents.length} документов, ${catalog.conditions.length} условий.`);
console.log("Откройте бота в MAX и нажмите «Начать». Ctrl+C — остановить.\n");

let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopped = true;
    console.log(`\nостановка по ${signal}…`);
  });
}

function readCallbackId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const callback = (payload as { callback?: unknown }).callback;
  if (typeof callback !== "object" || callback === null) return undefined;
  const id = (callback as { callback_id?: unknown }).callback_id;
  return typeof id === "string" ? id : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handle(update: unknown): Promise<void> {
  if (!isUpdateLike(update)) return;
  const parsed = parseUpdate(update, Date.now());

  const inserted = await store.rawUpdates.insert({
    dedupeKey: parsed.dedupeKey,
    updateType: parsed.updateType,
    chatId: parsed.chatId,
    userId: parsed.userId,
    payload: update,
    late: parsed.late,
  });
  if (inserted.duplicate || !inserted.id) return;

  const raw = await store.rawUpdates.get(inserted.id);
  if (!raw) return;

  // Ответ на нажатие кнопки гасит индикатор ожидания в MAX; ошибка не критична.
  if (raw.updateType === "message_callback") {
    const callbackId = readCallbackId(raw.payload);
    if (callbackId) {
      try {
        await max.answerCallback({ callbackId });
      } catch {
        // необязательный шаг
      }
    }
  }

  const result = await processRawUpdate({ store, scenario, catalog }, raw);
  const status = result.status === "done" ? "done" : result.status === "skipped" ? "skipped" : "failed";
  await store.rawUpdates.markProcessed(raw.id, status, result.reason);

  if (result.status === "done") {
    const delivery = await deliverOutbox({ outbox: store.outbox, max });
    if (delivery.sent > 0) console.log(`→ ${raw.updateType}: отправлено сообщений — ${delivery.sent}`);
  } else if (result.status === "failed") {
    console.warn(`! ${raw.updateType} не обработано: ${result.reason ?? "?"}`);
  }
}

let marker: number | undefined;
while (!stopped) {
  let response;
  try {
    response = await max.api.getUpdates(undefined, {
      timeout: 30,
      ...(marker !== undefined ? { marker } : {}),
    });
  } catch (error) {
    console.error(`опрос MAX не удался: ${describe(error)}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    continue;
  }

  marker = response.marker;
  for (const update of response.updates) {
    try {
      await handle(update);
    } catch (error) {
      console.error(`обработка события упала: ${describe(error)}`);
    }
  }
}

console.log("Готово.");
