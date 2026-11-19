import path from "node:path";
import type { Message, Update } from "@maxhub/max-bot-api/types";
import { describe, expect, it } from "vitest";
import { loadCatalog, type Catalog } from "../src/catalog.js";
import { deliverOutbox } from "../src/dialog/deliver.js";
import { processRawUpdate } from "../src/dialog/process.js";
import { loadScenario, type Scenario } from "../src/engine/scenario.js";
import type { MaxClient, SendMessageParams } from "../src/max/client.js";
import { createMemoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/index.js";
import { parseUpdate } from "../src/updates.js";

// Хранилище в памяти — тот же путь, что у `npm run poll`: событие MAX →
// parseUpdate → processRawUpdate → deliverOutbox. Ни Postgres, ни Redis, ни
// сети. Так проверяем и само in-memory хранилище, и локальный запуск.

const root = process.cwd();
const catalog: Catalog = loadCatalog(path.join(root, "content", "catalog.json"));
const scenario: Scenario = loadScenario(path.join(root, "content", "scenarios", "example.yaml"), catalog);

interface SentMessage {
  chatId: number;
  text: string;
  hasKeyboard: boolean;
}

function fakeMax(): { sent: SentMessage[]; max: Pick<MaxClient, "sendMessage" | "editMessage"> } {
  const sent: SentMessage[] = [];
  return {
    sent,
    max: {
      async sendMessage(params: SendMessageParams): Promise<Message> {
        sent.push({ chatId: params.chatId, text: params.text, hasKeyboard: Boolean(params.keyboard) });
        return { body: { mid: `mid-${sent.length}` } } as unknown as Message;
      },
      async editMessage(): Promise<void> {
        /* в этом сценарии правок нет */
      },
    },
  };
}

// Повторяет последовательность раннера: дедуп → обработка → доставка.
async function pipe(
  store: Store,
  max: Pick<MaxClient, "sendMessage" | "editMessage">,
  update: Update,
): Promise<"duplicate" | "done" | "skipped"> {
  const parsed = parseUpdate(update, 1_700_000_000_000);
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

const started = {
  update_type: "bot_started",
  timestamp: 1_700_000_000,
  chat_id: 10,
  user: { user_id: 20 },
  payload: null,
} as unknown as Update;

function callback(index: number, stepId: string, value: string | string[]): Update {
  return {
    update_type: "message_callback",
    timestamp: 1_700_000_000,
    callback: {
      timestamp: 1_700_000_000,
      callback_id: `cb-${index}`,
      payload: JSON.stringify({ s: stepId, v: value }),
      user: { user_id: 20 },
    },
    message: { recipient: { chat_id: 10 }, body: { mid: `m-${index}` } },
  } as unknown as Update;
}

describe("хранилище в памяти", () => {
  it("сессии: создание, оптимистичная блокировка, рестарт", async () => {
    const store = createMemoryStore();
    const user = await store.sessions.upsertUser({ maxUserId: 20, chatId: 10 });

    const created = await store.sessions.createSession({
      publicId: "p1",
      userId: user.id,
      scenarioCode: "bankruptcy",
      scenarioVersion: 1,
      catalogVersion: "v1",
      state: { answers: {}, currentStep: "who", history: [], flags: { disclaimerShown: false } },
      currentStep: "who",
    });
    expect(created.version).toBe(1);
    expect(await store.sessions.getActiveSession(user.id)).toBeDefined();

    // Версия не совпала — запись отклоняется (конфликт).
    const conflict = await store.sessions.saveState({
      id: created.id,
      expectedVersion: 99,
      state: created.state,
      currentStep: "debt",
      status: "active",
    });
    expect(conflict).toBeUndefined();

    // Версия совпала — состояние обновляется, версия растёт.
    const next = await store.sessions.saveState({
      id: created.id,
      expectedVersion: 1,
      state: { answers: { who: "person" }, currentStep: "debt", history: ["who"], flags: { disclaimerShown: false } },
      currentStep: "debt",
      status: "active",
    });
    expect(next).toBe(2);

    await store.sessions.abandonActiveSessions(user.id);
    expect(await store.sessions.getActiveSession(user.id)).toBeUndefined();
  });

  it("raw updates: дедупликация по ключу", async () => {
    const store = createMemoryStore();
    const input = { dedupeKey: "k", updateType: "bot_started", chatId: 10, userId: 20, payload: {}, late: false };

    const first = await store.rawUpdates.insert(input);
    expect(first.duplicate).toBe(false);
    expect(await store.rawUpdates.get(first.id ?? "")).toBeDefined();

    expect((await store.rawUpdates.insert(input)).duplicate).toBe(true);
  });

  it("outbox: дедупликация, доставка и повтор с задержкой", async () => {
    let clock = 1_000;
    const store = createMemoryStore(() => clock);
    const enqueued = await store.outbox.enqueue({ chatId: 10, sessionId: null, kind: "message", payload: {}, idempotencyKey: "i1" });
    expect(enqueued.inserted).toBe(true);
    expect((await store.outbox.enqueue({ chatId: 10, sessionId: null, kind: "message", payload: {}, idempotencyKey: "i1" })).inserted).toBe(false);

    const [claimed] = await store.outbox.claim(5);
    expect(claimed?.attempts).toBe(1);

    // Повтор: пока не наступило next_at, задание не забирается.
    await store.outbox.markFailed({ id: claimed?.id ?? "", error: "boom", retryAt: new Date(clock + 2_000) });
    expect(await store.outbox.claim(5)).toHaveLength(0);

    clock += 2_000;
    expect((await store.outbox.claim(5))[0]?.attempts).toBe(2);
  });
});

describe("локальный путь (как в npm run poll)", () => {
  it("проходит диалог от /start до чек-листа и отправляет сообщения", async () => {
    const store = createMemoryStore();
    const { sent, max } = fakeMax();

    expect(await pipe(store, max, started)).toBe("done");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(10);
    expect(sent[0]?.hasKeyboard).toBe(true);

    const walk: Array<[string, string | string[]]> = [
      ["who", "person"],
      ["debt", "under_100k"],
      ["overdue", "no"],
      ["property", ["flat"]],
      ["income", ["salary"]],
      ["credits", ["cards"]],
      ["deals", "no"],
      ["marital", "single"],
      ["children", "no"],
    ];
    for (const [index, [stepId, value]] of walk.entries()) {
      expect(await pipe(store, max, callback(index, stepId, value))).toBe("done");
    }

    const last = sent[sent.length - 1];
    expect(last?.text).toContain("Ваш список документов");
    expect(last?.text).toContain("Обязательно собрать");
    expect(last?.text).toContain("информационный сервис");
    // На чек-листе клавиатура остаётся — кнопка «Начать заново».
    expect(last?.hasKeyboard).toBe(true);
  });

  it("повторная доставка того же события не дублирует сообщение", async () => {
    const store = createMemoryStore();
    const { sent, max } = fakeMax();

    expect(await pipe(store, max, started)).toBe("done");
    expect(await pipe(store, max, started)).toBe("duplicate");
    expect(sent).toHaveLength(1);
  });
});
