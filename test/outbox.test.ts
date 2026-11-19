import type { Message } from "@maxhub/max-bot-api/types";
import { describe, expect, it } from "vitest";
import { deliverOutbox, retryDelayMs, UnsupportedOutboxKindError } from "../src/dialog/deliver.js";
import type { MaxClient } from "../src/max/client.js";
import type { MarkFailedInput, OutboxRecord, OutboxRepo } from "../src/store/outbox.js";

// Доставка outbox: успех, повтор при ошибке, dead при исчерпании попыток и
// при неизвестном типе задания. MAX подменяется, БД — в памяти.

class FakeOutbox implements OutboxRepo {
  readonly sent: Array<{ id: string; messageId: string | null }> = [];
  readonly failed: MarkFailedInput[] = [];
  private readonly queue: OutboxRecord[];

  constructor(records: OutboxRecord[]) {
    this.queue = [...records];
  }

  async enqueue(): Promise<{ inserted: boolean }> {
    return { inserted: true };
  }

  async claim(limit: number): Promise<OutboxRecord[]> {
    return this.queue.splice(0, limit);
  }

  async markSent(id: string, messageId: string | null): Promise<void> {
    this.sent.push({ id, messageId });
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    this.failed.push(input);
  }
}

type MaxPort = Pick<MaxClient, "sendMessage" | "editMessage">;

function record(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return { id: "o1", chatId: 10, kind: "message", payload: { chatId: 10, text: "привет" }, attempts: 0, ...overrides };
}

describe("retryDelayMs", () => {
  it("экспоненциальная задержка с потолком", () => {
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(1)).toBe(2000);
    expect(retryDelayMs(2)).toBe(4000);
    expect(retryDelayMs(20)).toBe(60_000);
  });
});

describe("deliverOutbox", () => {
  it("отправляет сообщение и фиксирует mid", async () => {
    const outbox = new FakeOutbox([record()]);
    const max: MaxPort = {
      async sendMessage() {
        return { body: { mid: "mid-1" } } as unknown as Message;
      },
      async editMessage() {
        /* не вызывается */
      },
    };

    const result = await deliverOutbox({ outbox, max });

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(outbox.sent).toEqual([{ id: "o1", messageId: "mid-1" }]);
  });

  it("редактирование помечается отправленным без mid", async () => {
    const outbox = new FakeOutbox([
      record({ kind: "edit", payload: { messageId: "m1", text: "новый текст" } }),
    ]);
    const edited: string[] = [];
    const max: MaxPort = {
      async sendMessage() {
        throw new Error("не должен вызываться");
      },
      async editMessage(params) {
        edited.push(params.messageId);
      },
    };

    const result = await deliverOutbox({ outbox, max });

    expect(result.sent).toBe(1);
    expect(edited).toEqual(["m1"]);
    expect(outbox.sent).toEqual([{ id: "o1", messageId: null }]);
  });

  it("при ошибке ставит повтор с задержкой", async () => {
    const outbox = new FakeOutbox([record({ attempts: 1 })]);
    const max: MaxPort = {
      async sendMessage() {
        throw new Error("сеть недоступна");
      },
      async editMessage() {
        /* не вызывается */
      },
    };

    const now = 1_000_000;
    const result = await deliverOutbox({ outbox, max, now: () => now });

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(outbox.failed).toHaveLength(1);
    expect(outbox.failed[0]?.error).toBe("сеть недоступна");
    // attempts = 1 → задержка 2с.
    expect(outbox.failed[0]?.retryAt?.getTime()).toBe(now + 2000);
  });

  it("при исчерпании попыток помечает dead (retryAt = null)", async () => {
    const outbox = new FakeOutbox([record({ attempts: 5 })]);
    const max: MaxPort = {
      async sendMessage() {
        throw new Error("всё ещё плохо");
      },
      async editMessage() {
        /* не вызывается */
      },
    };

    await deliverOutbox({ outbox, max, maxAttempts: 5 });
    expect(outbox.failed[0]?.retryAt).toBeNull();
  });

  it("неизвестный тип задания — dead без повторов", async () => {
    const outbox = new FakeOutbox([record({ kind: "telepathy", attempts: 0 })]);
    const max: MaxPort = {
      async sendMessage() {
        throw new Error("не должен вызываться");
      },
      async editMessage() {
        /* не вызывается */
      },
    };

    const result = await deliverOutbox({ outbox, max });

    expect(result.failed).toBe(1);
    expect(outbox.failed[0]?.retryAt).toBeNull();
    expect(outbox.failed[0]?.error).toContain("telepathy");
  });

  it("соблюдает лимит пачки", async () => {
    const outbox = new FakeOutbox([record({ id: "o1" }), record({ id: "o2" }), record({ id: "o3" })]);
    const max: MaxPort = {
      async sendMessage() {
        return { body: { mid: "m" } } as unknown as Message;
      },
      async editMessage() {
        /* не вызывается */
      },
    };

    const result = await deliverOutbox({ outbox, max, limit: 2 });
    expect(result.sent).toBe(2);
  });

  it("UnsupportedOutboxKindError содержит тип", () => {
    expect(new UnsupportedOutboxKindError("x").message).toContain("x");
  });
});
