import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog, type Catalog } from "../src/catalog.js";
import { runDialog } from "../src/dialog/orchestrator.js";
import { processRawUpdate } from "../src/dialog/process.js";
import { outcomeToScreens } from "../src/dialog/screens.js";
import { loadScenario, type Scenario } from "../src/engine/scenario.js";
import { loadGuides } from "../src/knowledge/guides.js";
import { createMemoryStore } from "../src/store/memory.js";
import type { RawUpdateRecord } from "../src/store/raw-updates.js";

// Тесты оркестратора, экранов и обработки события. Хранилище — в памяти:
// ни Postgres, ни Redis, ни сети. Сценарий, каталог и гайды берём настоящие.

const root = process.cwd();
const catalog: Catalog = loadCatalog(path.join(root, "content", "catalog.json"));
const guides = loadGuides(path.join(root, "content", "guides.json"));
const scenario: Scenario = loadScenario(path.join(root, "content", "scenarios", "example.yaml"));

function raw(id: string, payload: unknown, chatId: number | null = 10, userId: number | null = 20): RawUpdateRecord {
  return { id, dedupeKey: id, updateType: "x", chatId, userId, payload, late: false, status: "new" };
}

function botStarted(id = "r1"): RawUpdateRecord {
  return raw(id, {
    update_type: "bot_started",
    timestamp: 1_700_000_000,
    chat_id: 10,
    user: { user_id: 20 },
    payload: null,
  });
}

function staleAnswer(id: string, stepId: string, value: string | string[]): RawUpdateRecord {
  return raw(id, {
    update_type: "message_callback",
    timestamp: 1_700_000_000,
    callback: {
      timestamp: 1_700_000_000,
      callback_id: `cb-${id}`,
      payload: JSON.stringify({ s: stepId, v: value }),
      user: { user_id: 20 },
    },
    message: { recipient: { chat_id: 10 }, body: { mid: `m-${id}` } },
  });
}

describe("оркестратор диалога", () => {
  it("«Начать» показывает терминальный шаг-инструкцию", () => {
    const outcome = runDialog({ scenario, catalog, guides, event: { type: "start" } });
    expect(outcome.status).toBe("ok");
    expect(outcome.terminal).toBe(true);
    expect(outcome.steps[0]?.stepId).toBe("instruction");
    expect(outcome.steps[0]?.view.options).toHaveLength(0);
    expect(outcome.steps[0]?.nav).toEqual({ back: false, restart: true });
    expect(outcome.instruction?.total).toBe(catalog.documents.length);
    expect(outcome.disclaimer).toContain("информационный сервис");
  });

  it("инструкция сгруппирована по сервисам", () => {
    const outcome = runDialog({ scenario, catalog, guides, event: { type: "start" } });
    const services = outcome.instruction?.sections.map((section) => section.service) ?? [];
    expect(services).toContain("Госуслуги");
    expect(services.length).toBeGreaterThan(1);
  });

  it("устаревшее событие ответа — noop без падения", () => {
    const outcome = runDialog({ scenario, catalog, event: { type: "answer", stepId: "debt", value: "x" } });
    expect(outcome.status).toBe("noop");
    expect(outcome.reason).toBe("unsupported_event");
    expect(outcome.steps).toHaveLength(0);
  });
});

describe("экраны", () => {
  it("инструкция режется на сообщения, клавиатура — на последнем", () => {
    const outcome = runDialog({ scenario, catalog, guides, event: { type: "start" } });
    const screens = outcomeToScreens(outcome, { chatId: 10, sessionId: "s1", sourceKey: "r9" });

    expect(screens.length).toBeGreaterThan(1);
    const first = screens[0];
    const last = screens[screens.length - 1];
    if (!first || !last) throw new Error("нет экранов");

    expect((first.payload as { text: string }).text).toContain("Как получить документы");
    expect((first.payload as { keyboard?: unknown }).keyboard).toBeUndefined();
    expect((last.payload as { keyboard?: unknown }).keyboard).toBeDefined();
    expect(last.idempotencyKey).toBe(`r9:instruction:${screens.length - 1}`);

    const text = screens.map((screen) => (screen.payload as { text: string }).text).join("\n");
    expect(text).toContain("Всего документов");
    expect(text).toContain("может понадобиться");
    expect(text).toContain("информационный сервис");
  });

  it("ключ идемпотентности стабилен при повторном построении", () => {
    const outcome = runDialog({ scenario, catalog, guides, event: { type: "start" } });
    const first = outcomeToScreens(outcome, { chatId: 10, sessionId: null, sourceKey: "r1" });
    const second = outcomeToScreens(outcome, { chatId: 10, sessionId: null, sourceKey: "r1" });
    expect(first.map((screen) => screen.idempotencyKey)).toEqual(second.map((screen) => screen.idempotencyKey));
  });
});

describe("обработка события", () => {
  it("bot_started создаёт сессию и кладёт инструкцию в outbox", async () => {
    const store = createMemoryStore();
    const result = await processRawUpdate({ store, scenario, catalog, guides }, botStarted());

    expect(result.status).toBe("done");
    const records = await store.outbox.claim(100);
    expect(records.length).toBeGreaterThan(1);

    const text = records.map((record) => (record.payload as { text: string }).text).join("\n");
    expect(text).toContain("Как получить документы");
    expect(text).toContain("Всего документов");
    expect(text).toContain("может понадобиться");
  });

  it("событие без диалога — skipped", async () => {
    const store = createMemoryStore();
    const result = await processRawUpdate(
      { store, scenario, catalog, guides },
      raw("r1", {
        update_type: "message_created",
        timestamp: 1_700_000_000,
        message: { recipient: { chat_id: 10 }, body: { mid: "m1" } },
      }),
    );
    expect(result).toEqual({ status: "skipped", reason: "no_dialog_event" });
  });

  it("событие без чата — skipped", async () => {
    const store = createMemoryStore();
    const noChat = await processRawUpdate(
      { store, scenario, catalog, guides },
      raw("r2", { update_type: "bot_started", timestamp: 1_700_000_000, chat_id: 10, user: { user_id: 20 }, payload: null }, null, 20),
    );
    expect(noChat).toEqual({ status: "skipped", reason: "no_chat" });
  });

  it("устаревшая кнопка ответа — skipped", async () => {
    const store = createMemoryStore();
    const result = await processRawUpdate({ store, scenario, catalog, guides }, staleAnswer("a1", "who", "person"));
    expect(result).toEqual({ status: "skipped", reason: "unsupported_event" });
  });

  it("повторная доставка того же события не создаёт дубль экрана", async () => {
    const store = createMemoryStore();
    await processRawUpdate({ store, scenario, catalog, guides }, botStarted("r1"));
    await store.outbox.claim(100);
    // Повторный bot_started с тем же id записи: ключи идемпотентности те же —
    // новых заданий не появляется.
    await processRawUpdate({ store, scenario, catalog, guides }, botStarted("r1"));
    expect(await store.outbox.claim(100)).toHaveLength(0);
  });

  it("битый payload — skipped", async () => {
    const store = createMemoryStore();
    const result = await processRawUpdate({ store, scenario, catalog, guides }, raw("r1", "не объект"));
    expect(result).toEqual({ status: "skipped", reason: "bad_payload" });
  });
});
