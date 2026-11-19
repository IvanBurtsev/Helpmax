import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { SessionState } from "../src/engine/transition.js";
import { createStore, poolToQueryable } from "../src/store/index.js";
import { OutboxStore } from "../src/store/outbox.js";
import { RawUpdateStore } from "../src/store/raw-updates.js";
import { SessionStore } from "../src/store/sessions.js";
import { toNullableNumber, toNullableString, toNumber, type Queryable, type QueryResultLike } from "../src/store/sql.js";

// Подменный доступ к БД: записывает запросы и отдаёт заранее заданные строки.
// Так репозитории проверяются без Postgres — важно и для CI, и для скорости.

type Responder = (text: string, values?: readonly unknown[]) => QueryResultLike;

class FakeDb implements Queryable {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];

  constructor(private readonly responder: Responder) {}

  async query(text: string, values?: readonly unknown[]): Promise<QueryResultLike> {
    this.calls.push(values ? { text, values } : { text });
    return this.responder(text, values);
  }
}

function result(rows: Array<Record<string, unknown>>): QueryResultLike {
  return { rows, rowCount: rows.length };
}

const sessionRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "s1",
  public_id: "p1",
  user_id: "u1",
  scenario_code: "bankruptcy",
  scenario_version: 1,
  catalog_version: "2026-11-19",
  state: { answers: {}, currentStep: "who", history: [], flags: { disclaimerShown: false } },
  version: 0,
  status: "active",
  current_step: "who",
  ...overrides,
});

describe("хелперы sql", () => {
  it("приводит bigint-строки и null", () => {
    expect(toNumber("42")).toBe(42);
    expect(toNumber(7)).toBe(7);
    expect(toNullableNumber(null)).toBeNull();
    expect(toNullableNumber("13")).toBe(13);
    expect(toNullableString(null)).toBeNull();
    expect(toNullableString("x")).toBe("x");
  });
});

describe("SessionStore", () => {
  it("upsertUser создаёт/обновляет пользователя и маппит строку", async () => {
    const db = new FakeDb(() => result([{ id: "u1", max_user_id: "555", chat_id: "777" }]));
    const store = new SessionStore(db);

    const user = await store.upsertUser({ maxUserId: 555, chatId: 777, displayName: "Иван" });

    expect(user).toEqual({ id: "u1", maxUserId: 555, chatId: 777 });
    expect(db.calls[0]?.text).toContain("on conflict (max_user_id)");
    expect(db.calls[0]?.values).toEqual([555, 777, "Иван"]);
  });

  it("getActiveSession возвращает сессию или undefined", async () => {
    const found = new SessionStore(new FakeDb(() => result([sessionRow()])));
    const session = await found.getActiveSession("u1");
    expect(session?.id).toBe("s1");
    expect(session?.currentStep).toBe("who");

    const empty = new SessionStore(new FakeDb(() => result([])));
    expect(await empty.getActiveSession("u1")).toBeUndefined();
  });

  it("createSession вставляет состояние как jsonb", async () => {
    const db = new FakeDb(() => result([sessionRow()]));
    const store = new SessionStore(db);
    const state: SessionState = { answers: {}, currentStep: "who", history: [], flags: { disclaimerShown: false } };

    const session = await store.createSession({
      publicId: "p1",
      userId: "u1",
      scenarioCode: "bankruptcy",
      scenarioVersion: 1,
      catalogVersion: "2026-11-19",
      state,
      currentStep: "who",
    });

    expect(session.publicId).toBe("p1");
    expect(db.calls[0]?.text).toContain("$6::jsonb");
    expect(db.calls[0]?.values?.[5]).toBe(JSON.stringify(state));
  });

  it("saveState возвращает версию и undefined при конфликте", async () => {
    const db = new FakeDb(() => result([{ version: "3" }]));
    const ok = new SessionStore(db);
    const version = await ok.saveState({
      id: "s1",
      expectedVersion: 2,
      state: { answers: {}, currentStep: "debt", history: ["who"], flags: { disclaimerShown: false } },
      currentStep: "debt",
      status: "active",
    });
    expect(version).toBe(3);
    expect(db.calls[0]?.text).toContain("where id = $1 and version = $5");

    const conflict = new SessionStore(new FakeDb(() => result([])));
    expect(
      await conflict.saveState({
        id: "s1",
        expectedVersion: 2,
        state: { answers: {}, currentStep: "debt", history: [], flags: { disclaimerShown: false } },
        currentStep: "debt",
        status: "active",
      }),
    ).toBeUndefined();
  });

  it("appendAnswer и abandonActiveSessions выполняют запросы", async () => {
    const db = new FakeDb(() => result([]));
    const store = new SessionStore(db);

    await store.appendAnswer({ sessionId: "s1", stepId: "who", value: "person" });
    await store.abandonActiveSessions("u1");

    expect(db.calls[0]?.text).toContain("insert into answers");
    expect(db.calls[0]?.values).toEqual(["s1", "who", JSON.stringify("person")]);
    expect(db.calls[1]?.text).toContain("status = 'abandoned'");
  });
});

describe("RawUpdateStore", () => {
  it("insert: новая запись возвращает id, повтор — duplicate", async () => {
    const db = new FakeDb(() => result([{ id: "r1" }]));
    const fresh = new RawUpdateStore(db);
    expect(await fresh.insert({ dedupeKey: "k", updateType: "bot_started", chatId: 1, userId: 2, payload: {}, late: false })).toEqual({
      duplicate: false,
      id: "r1",
    });
    expect(db.calls[0]?.text).toContain("on conflict (dedupe_key) do nothing");

    const dup = new RawUpdateStore(new FakeDb(() => result([])));
    expect(await dup.insert({ dedupeKey: "k", updateType: "bot_started", chatId: 1, userId: 2, payload: {}, late: false })).toEqual({
      duplicate: true,
    });
  });

  it("get маппит строку, markProcessed пишет статус и ошибку", async () => {
    const db = new FakeDb((text) => {
      if (text.startsWith("select")) {
        return result([
          { id: "r1", dedupe_key: "k", update_type: "message_created", chat_id: "1", user_id: "2", payload: { a: 1 }, late: true, status: "new" },
        ]);
      }
      return result([]);
    });
    const store = new RawUpdateStore(db);

    const record = await store.get("r1");
    expect(record?.chatId).toBe(1);
    expect(record?.userId).toBe(2);
    expect(record?.late).toBe(true);

    await store.markProcessed("r1", "failed", "boom");
    const update = db.calls.find((call) => call.text.startsWith("update"));
    expect(update?.text).toContain("processed_at = now()");
    expect(update?.values).toEqual(["r1", "failed", "boom"]);
  });
});

describe("OutboxStore", () => {
  it("enqueue: новая задача inserted, повтор — нет", async () => {
    const db = new FakeDb(() => result([{ id: "o1" }]));
    const fresh = new OutboxStore(db);
    expect(
      await fresh.enqueue({ chatId: 1, sessionId: "s1", kind: "message", payload: {}, idempotencyKey: "i1" }),
    ).toEqual({ inserted: true, id: "o1" });
    expect(db.calls[0]?.text).toContain("on conflict (idempotency_key) do nothing");

    const dup = new OutboxStore(new FakeDb(() => result([])));
    expect(
      await dup.enqueue({ chatId: 1, sessionId: null, kind: "message", payload: {}, idempotencyKey: "i1" }),
    ).toEqual({ inserted: false });
  });

  it("claim берёт пачку и маппит строки", async () => {
    const db = new FakeDb(() =>
      result([{ id: "o1", chat_id: "10", kind: "message", payload: { text: "привет" }, attempts: "1" }]),
    );
    const store = new OutboxStore(db);

    const records = await store.claim(5);
    expect(records).toEqual([{ id: "o1", chatId: 10, kind: "message", payload: { text: "привет" }, attempts: 1 }]);
    expect(db.calls[0]?.text).toContain("for update skip locked");
    // «Зависшие» отправки (воркер упал) возвращаются в оборот через 2 минуты.
    expect(db.calls[0]?.text).toContain("interval '2 minutes'");
  });

  it("markSent фиксирует mid, markFailed — повтор или dead", async () => {
    const db = new FakeDb(() => result([]));
    const store = new OutboxStore(db);

    await store.markSent("o1", "mid-1");
    await store.markFailed({ id: "o2", error: "boom", retryAt: new Date(1000) });
    await store.markFailed({ id: "o3", error: "dead", retryAt: null });

    expect(db.calls[0]?.text).toContain("status = 'sent'");
    expect(db.calls[0]?.values).toEqual(["o1", "mid-1"]);
    expect(db.calls[1]?.text).toContain("status = 'pending'");
    expect(db.calls[2]?.text).toContain("status = 'dead'");
  });
});

describe("createStore", () => {
  it("собирает репозитории над пулом и адаптер пула проксирует query", async () => {
    const store = createStore({} as Pool);
    expect(typeof store.sessions.upsertUser).toBe("function");
    expect(typeof store.rawUpdates.insert).toBe("function");
    expect(typeof store.outbox.enqueue).toBe("function");

    const calls: string[] = [];
    const fakePool = {
      query: async (text: string) => {
        calls.push(text);
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
    } as unknown as Pool;
    const queryable = poolToQueryable(fakePool);
    const res = await queryable.query("select 1");
    expect(calls).toEqual(["select 1"]);
    expect(res.rows).toEqual([{ ok: 1 }]);
  });
});
