import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { InsertRawUpdateInput, RawUpdateRecord, RawUpdatesRepo } from "../src/store/raw-updates.js";

// Маршрут webhook: проверка секрета, запись события, постановка в очередь.
// Fastify inject() — без реального порта; хранилище и очередь подменены.

class FakeRawUpdates implements RawUpdatesRepo {
  readonly inserted: InsertRawUpdateInput[] = [];

  constructor(private readonly duplicate = false) {}

  async insert(input: InsertRawUpdateInput): Promise<{ duplicate: boolean; id?: string }> {
    this.inserted.push(input);
    return this.duplicate ? { duplicate: true } : { duplicate: false, id: "r1" };
  }

  async get(): Promise<RawUpdateRecord | undefined> {
    return undefined;
  }

  async markProcessed(): Promise<void> {
    /* не используется */
  }
}

const config = loadConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MAX_WEBHOOK_SECRET: "secret-123",
} as NodeJS.ProcessEnv);

const botStarted = {
  update_type: "bot_started",
  timestamp: 1_700_000_000,
  chat_id: 10,
  user: { user_id: 20 },
  payload: null,
};

function appWith(rawUpdates: FakeRawUpdates, enqueued: string[]) {
  return buildApp({
    config,
    rawUpdates,
    enqueueUpdate: async (id) => {
      enqueued.push(id);
    },
    now: () => 1_700_000_000_000,
    logger: false,
  });
}

describe("webhook MAX", () => {
  it("healthz отвечает ok", async () => {
    const app = appWith(new FakeRawUpdates(), []);
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("принимает событие: пишет в raw_updates и ставит в очередь", async () => {
    const rawUpdates = new FakeRawUpdates();
    const enqueued: string[] = [];
    const app = appWith(rawUpdates, enqueued);

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-max-bot-api-secret": "secret-123" },
      payload: botStarted,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(rawUpdates.inserted).toHaveLength(1);
    expect(rawUpdates.inserted[0]?.updateType).toBe("bot_started");
    expect(rawUpdates.inserted[0]?.chatId).toBe(10);
    expect(enqueued).toEqual(["r1"]);
    await app.close();
  });

  it("неверный секрет — 403 и ничего не пишем", async () => {
    const rawUpdates = new FakeRawUpdates();
    const enqueued: string[] = [];
    const app = appWith(rawUpdates, enqueued);

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-max-bot-api-secret": "wrong" },
      payload: botStarted,
    });

    expect(response.statusCode).toBe(403);
    expect(rawUpdates.inserted).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    await app.close();
  });

  it("без секрета в конфиге — 403", async () => {
    const noSecret = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
    const app = buildApp({
      config: noSecret,
      rawUpdates: new FakeRawUpdates(),
      enqueueUpdate: async () => undefined,
      logger: false,
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-max-bot-api-secret": "secret-123" },
      payload: botStarted,
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("дубликат события не ставится в очередь", async () => {
    const enqueued: string[] = [];
    const app = appWith(new FakeRawUpdates(true), enqueued);

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-max-bot-api-secret": "secret-123" },
      payload: botStarted,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, duplicate: true });
    expect(enqueued).toHaveLength(0);
    await app.close();
  });

  it("битое тело — 200 ok:false, без записи", async () => {
    const rawUpdates = new FakeRawUpdates();
    const app = appWith(rawUpdates, []);

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-max-bot-api-secret": "secret-123" },
      payload: { hello: "world" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, reason: "bad_update" });
    expect(rawUpdates.inserted).toHaveLength(0);
    await app.close();
  });
});
