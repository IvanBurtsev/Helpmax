import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog, type Catalog } from "../src/catalog.js";
import { runDialog } from "../src/dialog/orchestrator.js";
import { processRawUpdate } from "../src/dialog/process.js";
import { outcomeToScreens } from "../src/dialog/screens.js";
import { loadScenario, type Scenario } from "../src/engine/scenario.js";
import type { RawUpdateRecord } from "../src/store/raw-updates.js";
import type {
  AppendAnswerInput,
  CreateSessionInput,
  SaveStateInput,
  SessionRecord,
  SessionsRepo,
  UpsertUserInput,
  UserRecord,
} from "../src/store/sessions.js";
import type { EnqueueInput, OutboxRecord, OutboxRepo } from "../src/store/outbox.js";
import type { RawUpdatesRepo } from "../src/store/raw-updates.js";
import type { Store } from "../src/store/index.js";

// Тесты оркестратора, экранов и обработки события. Хранилище — в памяти:
// ни Postgres, ни Redis, ни сети. Сценарий и каталог берём настоящие.

const root = process.cwd();
const catalog: Catalog = loadCatalog(path.join(root, "content", "catalog.json"));
const scenario: Scenario = loadScenario(path.join(root, "content", "scenarios", "example.yaml"), catalog);

// ---------- Хранилище в памяти ----------

interface Memory {
  store: Store;
  sessions: SessionRecord[];
  answers: AppendAnswerInput[];
  enqueued: EnqueueInput[];
}

function memoryStore(): Memory {
  let userSeq = 0;
  let sessionSeq = 0;
  const users = new Map<number, UserRecord>();
  const sessions: SessionRecord[] = [];
  const answers: AppendAnswerInput[] = [];
  const enqueued: EnqueueInput[] = [];

  const sessionsRepo: SessionsRepo = {
    async upsertUser(input: UpsertUserInput): Promise<UserRecord> {
      const existing = users.get(input.maxUserId);
      if (existing) return existing;
      userSeq += 1;
      const user: UserRecord = { id: `u${userSeq}`, maxUserId: input.maxUserId, chatId: input.chatId };
      users.set(input.maxUserId, user);
      return user;
    },
    async getActiveSession(userId: string): Promise<SessionRecord | undefined> {
      return sessions.find((s) => s.userId === userId && s.status === "active");
    },
    async createSession(input: CreateSessionInput): Promise<SessionRecord> {
      sessionSeq += 1;
      const session: SessionRecord = {
        id: `s${sessionSeq}`,
        publicId: input.publicId,
        userId: input.userId,
        scenarioCode: input.scenarioCode,
        scenarioVersion: input.scenarioVersion,
        catalogVersion: input.catalogVersion,
        state: input.state,
        version: 0,
        status: "active",
        currentStep: input.currentStep,
      };
      sessions.push(session);
      return session;
    },
    async saveState(input: SaveStateInput): Promise<number | undefined> {
      const session = sessions.find((s) => s.id === input.id);
      if (!session || session.version !== input.expectedVersion) return undefined;
      session.state = input.state;
      session.currentStep = input.currentStep;
      session.status = input.status;
      session.version += 1;
      return session.version;
    },
    async appendAnswer(input: AppendAnswerInput): Promise<void> {
      answers.push(input);
    },
    async completeSession(id: string): Promise<void> {
      const session = sessions.find((s) => s.id === id);
      if (session) session.status = "completed";
    },
    async abandonActiveSessions(userId: string): Promise<void> {
      for (const session of sessions) {
        if (session.userId === userId && session.status === "active") session.status = "abandoned";
      }
    },
  };

  const rawUpdates: RawUpdatesRepo = {
    async insert() {
      return { duplicate: true };
    },
    async get() {
      return undefined;
    },
    async markProcessed() {
      /* не используется */
    },
  };

  const outbox: OutboxRepo = {
    async enqueue(input: EnqueueInput) {
      if (enqueued.some((item) => item.idempotencyKey === input.idempotencyKey)) return { inserted: false };
      enqueued.push(input);
      return { inserted: true, id: `o${enqueued.length}` };
    },
    async claim(): Promise<OutboxRecord[]> {
      return [];
    },
    async markSent() {
      /* не используется */
    },
    async markFailed() {
      /* не используется */
    },
  };

  return { store: { sessions: sessionsRepo, rawUpdates, outbox }, sessions, answers, enqueued };
}

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

function answer(id: string, stepId: string, value: string | string[]): RawUpdateRecord {
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
  it("start показывает первый шаг с вариантами", () => {
    const outcome = runDialog({ scenario, catalog, event: { type: "start" } });
    expect(outcome.status).toBe("ok");
    expect(outcome.terminal).toBe(false);
    expect(outcome.steps[0]?.stepId).toBe("who");
    expect(outcome.steps[0]?.view.options.map((option) => option.id)).toContain("person");
    expect(outcome.steps[0]?.nav).toEqual({ back: false, restart: true });
  });

  it("ответ переводит на следующий шаг", () => {
    const first = runDialog({ scenario, catalog, event: { type: "start" } });
    const next = runDialog({
      scenario,
      catalog,
      state: first.state,
      event: { type: "answer", stepId: "who", value: "person" },
    });
    expect(next.steps[0]?.stepId).toBe("debt");
    expect(next.state.answers["who"]).toBe("person");
  });

  it("невалидное событие — noop без падения", () => {
    const outcome = runDialog({ scenario, catalog, event: { type: "answer", stepId: "debt", value: "x" } });
    expect(outcome.status).toBe("noop");
    expect(outcome.reason).toBe("stale_event");
    expect(outcome.steps).toHaveLength(0);
  });

  it("терминальный чек-лист собирается из каталога", () => {
    let state = runDialog({ scenario, catalog, event: { type: "start" } }).state;
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
    for (const [stepId, value] of walk) {
      state = runDialog({ scenario, catalog, state, event: { type: "answer", stepId, value } }).state;
    }
    const outcome = runDialog({ scenario, catalog, state, event: { type: "back" } });
    expect(outcome.steps[0]?.stepId).toBe("children");

    const final = runDialog({
      scenario,
      catalog,
      state: outcome.state,
      event: { type: "answer", stepId: "children", value: "no" },
    });
    expect(final.terminal).toBe(true);
    expect(final.steps[0]?.view.terminal).toBe(true);
    expect(final.checklist).toBeDefined();
    expect(final.checklist?.summary.required).toBeGreaterThan(0);
    expect(final.checklist?.summary.lawyer).toBeGreaterThan(0);
  });
});

describe("экраны", () => {
  it("делает по сообщению на шаг и добавляет чек-лист с дисклеймером", () => {
    let state = runDialog({ scenario, catalog, event: { type: "start" } }).state;
    const walk: Array<[string, string | string[]]> = [
      ["who", "person"],
      ["debt", "under_100k"],
      ["overdue", "no"],
      ["property", ["flat"]],
      ["income", ["salary"]],
      ["credits", ["cards"]],
      ["deals", "no"],
      ["marital", "single"],
    ];
    for (const [stepId, value] of walk) {
      state = runDialog({ scenario, catalog, state, event: { type: "answer", stepId, value } }).state;
    }
    const outcome = runDialog({
      scenario,
      catalog,
      state,
      event: { type: "answer", stepId: "children", value: "no" },
    });

    const screens = outcomeToScreens(outcome, { chatId: 10, sessionId: "s1", sourceKey: "r9" });
    expect(screens).toHaveLength(1);
    const payload = screens[0]?.payload as { text: string };
    expect(payload.text).toContain("Ваш список документов");
    expect(payload.text).toContain("Обязательно собрать");
    expect(payload.text).toContain("информационный сервис");
    expect(screens[0]?.idempotencyKey).toBe("r9:result:0");
  });

  it("ключ идемпотентности стабилен при повторном построении", () => {
    const outcome = runDialog({ scenario, catalog, event: { type: "start" } });
    const first = outcomeToScreens(outcome, { chatId: 10, sessionId: null, sourceKey: "r1" });
    const second = outcomeToScreens(outcome, { chatId: 10, sessionId: null, sourceKey: "r1" });
    expect(first.map((screen) => screen.idempotencyKey)).toEqual(second.map((screen) => screen.idempotencyKey));
  });
});

describe("обработка события", () => {
  it("bot_started создаёт сессию и кладёт экран в outbox", async () => {
    const memory = memoryStore();
    const result = await processRawUpdate({ store: memory.store, scenario, catalog }, botStarted());

    expect(result.status).toBe("done");
    expect(memory.sessions).toHaveLength(1);
    expect(memory.sessions[0]?.currentStep).toBe("who");
    expect(memory.sessions[0]?.status).toBe("active");
    expect(memory.enqueued).toHaveLength(1);
    expect(memory.enqueued[0]?.kind).toBe("message");
  });

  it("проходит весь диалог до чек-листа и закрывает сессию", async () => {
    const memory = memoryStore();
    await processRawUpdate({ store: memory.store, scenario, catalog }, botStarted("r0"));

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
      const result = await processRawUpdate({ store: memory.store, scenario, catalog }, answer(`a${index}`, stepId, value));
      expect(result.status).toBe("done");
    }

    expect(memory.sessions[0]?.status).toBe("completed");
    expect(memory.answers).toHaveLength(walk.length);

    const last = memory.enqueued[memory.enqueued.length - 1];
    const text = (last?.payload as { text: string }).text;
    expect(text).toContain("Ваш список документов");
    expect(text).toContain("Обязательно собрать");
    expect(text).toContain("информационный сервис");
  });

  it("событие без диалога — skipped", async () => {
    const memory = memoryStore();
    const result = await processRawUpdate(
      { store: memory.store, scenario, catalog },
      raw("r1", { update_type: "message_created", timestamp: 1_700_000_000, message: { recipient: { chat_id: 10 }, body: { mid: "m1" } } }),
    );
    expect(result).toEqual({ status: "skipped", reason: "no_dialog_event" });
  });

  it("событие без чата — skipped", async () => {
    const memory = memoryStore();
    const result = await processRawUpdate({ store: memory.store, scenario, catalog }, botStarted());
    expect(result.status).toBe("done");

    const noChat = await processRawUpdate(
      { store: memory.store, scenario, catalog },
      raw("r2", { update_type: "bot_started", timestamp: 1_700_000_000, chat_id: 10, user: { user_id: 20 }, payload: null }, null, 20),
    );
    expect(noChat).toEqual({ status: "skipped", reason: "no_chat" });
  });

  it("повторная доставка того же события не создаёт дубль экрана", async () => {
    const memory = memoryStore();
    await processRawUpdate({ store: memory.store, scenario, catalog }, botStarted("r1"));
    // Повторный bot_started с тем же id записи: сессия новая (start), но ключ
    // идемпотентности тот же — второй экран не создаётся.
    await processRawUpdate({ store: memory.store, scenario, catalog }, botStarted("r1"));
    expect(memory.enqueued).toHaveLength(1);
  });

  it("битый payload — skipped", async () => {
    const memory = memoryStore();
    const result = await processRawUpdate({ store: memory.store, scenario, catalog }, raw("r1", "не объект"));
    expect(result).toEqual({ status: "skipped", reason: "bad_payload" });
  });
});
