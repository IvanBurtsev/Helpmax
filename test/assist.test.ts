import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import { processRawUpdate } from "../src/dialog/process.js";
import { loadScenario } from "../src/engine/scenario.js";
import { loadGuides } from "../src/knowledge/guides.js";
import type { LlmClient } from "../src/llm/client.js";
import { createMemoryStore } from "../src/store/memory.js";
import type { RawUpdateRecord } from "../src/store/raw-updates.js";
import type { SttClient } from "../src/stt/client.js";

// Помощник: свободный текст, голос и кнопка «Не понятно» не меняют шаг диалога,
// а кладут ответ в outbox и возвращают пользователю текущий вопрос.

const root = process.cwd();
const catalog = loadCatalog(path.join(root, "content", "catalog.json"));
const guides = loadGuides(path.join(root, "content", "guides.json"));
const scenario = loadScenario(path.join(root, "content", "scenarios", "example.yaml"), catalog);

function raw(id: string, payload: unknown, chatId: number | null = 10, userId: number | null = 20): RawUpdateRecord {
  return { id, dedupeKey: id, updateType: "x", chatId, userId, payload, late: false, status: "new" };
}

function botStarted(id = "r1"): RawUpdateRecord {
  return raw(id, { update_type: "bot_started", timestamp: 1_700_000_000, chat_id: 10, user: { user_id: 20 }, payload: null });
}

function textMessage(id: string, text: string): RawUpdateRecord {
  return raw(id, {
    update_type: "message_created",
    timestamp: 1_700_000_000,
    message: {
      sender: { user_id: 20 },
      recipient: { chat_id: 10 },
      body: { mid: `m-${id}`, text },
    },
  });
}

function voiceMessage(id: string, url: string): RawUpdateRecord {
  return raw(id, {
    update_type: "message_created",
    timestamp: 1_700_000_000,
    message: {
      sender: { user_id: 20 },
      recipient: { chat_id: 10 },
      body: { mid: `m-${id}`, text: null, attachments: [{ type: "audio", payload: { url, token: "t" } }] },
    },
  });
}

function helpCallback(id: string, payload: string): RawUpdateRecord {
  return raw(id, {
    update_type: "message_callback",
    timestamp: 1_700_000_000,
    callback: { timestamp: 1_700_000_000, callback_id: `cb-${id}`, payload, user: { user_id: 20 } },
    message: { recipient: { chat_id: 10 }, body: { mid: `m-${id}` } },
  });
}

const fakeLlm: LlmClient = { model: "fake", complete: async () => "Вот подсказка по документу." };

describe("помощник", () => {
  it("свободный текст → ответ LLM и возврат к текущему шагу, шаг не меняется", async () => {
    const store = createMemoryStore();
    const deps = { store, scenario, catalog, guides, llm: fakeLlm };
    await processRawUpdate(deps, botStarted());
    await store.outbox.claim(10); // дренируем стартовый экран

    const result = await processRawUpdate(deps, textMessage("t1", "как получить паспорт?"));
    expect(result.status).toBe("done");

    const records = await store.outbox.claim(10);
    expect(records).toHaveLength(2);
    const answer = records[0]?.payload as { text: string };
    const back = records[1]?.payload as { text: string };
    expect(answer.text).toContain("Вот подсказка");
    expect(back.text).toContain("Кто вы?");

    // Шаг диалога не изменился: повторная подсказка снова возвращает «Кто вы?».
    await processRawUpdate(deps, textMessage("t2", "ещё вопрос"));
    const next = await store.outbox.claim(10);
    expect((next[1]?.payload as { text: string }).text).toContain("Кто вы?");
  });

  it("кнопка «Не понятно» → подсказка по текущему шагу", async () => {
    const store = createMemoryStore();
    const deps = { store, scenario, catalog, guides, llm: fakeLlm };
    await processRawUpdate(deps, botStarted());
    await store.outbox.claim(10);

    const result = await processRawUpdate(deps, helpCallback("h1", "help:step"));
    expect(result.status).toBe("done");
    const records = await store.outbox.claim(10);
    expect(records).toHaveLength(2);
    expect((records[0]?.payload as { text: string }).text).toContain("Вот подсказка");
  });

  it("голос без STT → просим написать текстом", async () => {
    const store = createMemoryStore();
    const deps = { store, scenario, catalog, guides, llm: fakeLlm };
    await processRawUpdate(deps, botStarted());
    await store.outbox.claim(10);

    const result = await processRawUpdate(deps, voiceMessage("v1", "https://cdn.max.ru/v.ogg"));
    expect(result.status).toBe("done");
    const records = await store.outbox.claim(10);
    expect((records[0]?.payload as { text: string }).text).toContain("Голосовые");
  });

  it("голос с STT → распознаём и отвечаем", async () => {
    const store = createMemoryStore();
    const stt: SttClient = { transcribe: async () => "как получить выписку" };
    const deps = { store, scenario, catalog, guides, llm: fakeLlm, stt };
    await processRawUpdate(deps, botStarted());
    await store.outbox.claim(10);

    await processRawUpdate(deps, voiceMessage("v2", "https://cdn.max.ru/v.ogg"));
    const records = await store.outbox.claim(10);
    const answer = records[0]?.payload as { text: string };
    expect(answer.text).toContain("🎤");
    expect(answer.text).toContain("как получить выписку");
    expect(answer.text).toContain("Вот подсказка");
  });

  it("без сессии и без гайдов — понятный откат, без падения", async () => {
    const store = createMemoryStore();
    const result = await processRawUpdate({ store, scenario, catalog }, textMessage("t9", "привет"));
    expect(result.status).toBe("done");
    const records = await store.outbox.claim(10);
    expect(records.length).toBeGreaterThan(0);
    expect((records[0]?.payload as { text: string }).text).toContain("юрист");
  });
});
