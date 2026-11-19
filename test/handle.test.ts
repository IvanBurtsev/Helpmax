import path from "node:path";
import type { Update } from "@maxhub/max-bot-api/types";
import { describe, expect, it } from "vitest";
import { loadCatalog, type Catalog } from "../src/catalog.js";
import { handleRawUpdate } from "../src/dialog/handle.js";
import { loadScenario, type Scenario } from "../src/engine/scenario.js";
import { createMemoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/index.js";
import { parseUpdate } from "../src/updates.js";

// Общий обработчик события — тот, что используют и воркер, и long polling.
// Проверяем: гашение колбэка, отметку статуса и путь ошибки.

const root = process.cwd();
const catalog: Catalog = loadCatalog(path.join(root, "content", "catalog.json"));
const scenario: Scenario = loadScenario(path.join(root, "content", "scenarios", "example.yaml"));

function fakeMax(): { answered: string[]; max: { answerCallback(params: { callbackId: string }): Promise<void> } } {
  const answered: string[] = [];
  return {
    answered,
    max: {
      async answerCallback(params: { callbackId: string }): Promise<void> {
        answered.push(params.callbackId);
      },
    },
  };
}

async function storeWith(store: Store, update: Update): Promise<{ id: string; store: Store }> {
  const parsed = parseUpdate(update, 1_700_000_000_000);
  const inserted = await store.rawUpdates.insert({
    dedupeKey: parsed.dedupeKey,
    updateType: parsed.updateType,
    chatId: parsed.chatId,
    userId: parsed.userId,
    payload: update,
    late: parsed.late,
  });
  return { id: inserted.id ?? "", store };
}

const started = {
  update_type: "bot_started",
  timestamp: 1_700_000_000,
  chat_id: 10,
  user: { user_id: 20 },
  payload: null,
} as unknown as Update;

const callback = {
  update_type: "message_callback",
  timestamp: 1_700_000_000,
  callback: {
    timestamp: 1_700_000_000,
    callback_id: "cb-0",
    payload: "nav:restart",
    user: { user_id: 20 },
  },
  message: { recipient: { chat_id: 10 }, body: { mid: "m-0" } },
} as unknown as Update;

// Подменяем только upsertUser, оставляя остальные методы через прототип.
function withThrowingUpsert(store: Store): Store {
  return {
    ...store,
    sessions: Object.assign(Object.create(store.sessions) as Store["sessions"], {
      upsertUser: async (): Promise<never> => {
        throw new Error("boom");
      },
    }),
  };
}

describe("обработчик события", () => {
  it("bot_started: помечает запись done и кладёт экран в outbox", async () => {
    const store = createMemoryStore();
    const { max, answered } = fakeMax();
    const { id } = await storeWith(store, started);
    const raw = await store.rawUpdates.get(id);
    if (!raw) throw new Error("нет записи");

    const result = await handleRawUpdate({ store, scenario, catalog, max }, raw);

    expect(result.status).toBe("done");
    expect((await store.rawUpdates.get(id))?.status).toBe("done");
    expect(answered).toHaveLength(0);
    expect(await store.outbox.claim(5)).not.toHaveLength(0);
  });

  it("message_callback: гасит индикатор кнопки", async () => {
    const store = createMemoryStore();
    const { max, answered } = fakeMax();
    await storeWith(store, started);
    const { id } = await storeWith(store, callback);
    const raw = await store.rawUpdates.get(id);
    if (!raw) throw new Error("нет записи");

    const result = await handleRawUpdate({ store, scenario, catalog, max }, raw);

    expect(result.status).toBe("done");
    expect(answered).toEqual(["cb-0"]);
  });

  it("ошибка обработки: помечает запись failed и пробрасывает исключение", async () => {
    const store = withThrowingUpsert(createMemoryStore());
    const { max } = fakeMax();
    const { id } = await storeWith(store, started);
    const raw = await store.rawUpdates.get(id);
    if (!raw) throw new Error("нет записи");

    await expect(handleRawUpdate({ store, scenario, catalog, max }, raw)).rejects.toThrow("boom");
    expect((await store.rawUpdates.get(id))?.status).toBe("failed");
  });
});
