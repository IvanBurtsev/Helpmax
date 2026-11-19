import type { Queue } from "bullmq";
import { describe, expect, it } from "vitest";
import { JOB_DELIVER, JOB_UPDATE, enqueueOutboxDelivery, enqueueUpdate } from "../src/queue.js";

// Фейковая очередь: запоминает вызовы add. Проверяем формат jobId — регресс:
// BullMQ не принимает целочисленные jobId (а id здесь bigserial) и jobId с ':'.

interface AddCall {
  name: string;
  data: unknown;
  opts: { jobId?: string };
}

function fakeQueue(): { calls: AddCall[]; queue: Queue } {
  const calls: AddCall[] = [];
  const queue = {
    add: async (name: string, data: unknown, opts: AddCall["opts"]) => {
      calls.push({ name, data, opts });
    },
  } as unknown as Queue;
  return { calls, queue };
}

describe("очереди", () => {
  it("jobId обновления не целочисленный и без ':'", async () => {
    const { calls, queue } = fakeQueue();
    await enqueueUpdate(queue, "13");

    expect(calls[0]?.name).toBe(JOB_UPDATE);
    expect(calls[0]?.data).toEqual({ rawUpdateId: "13" });

    const jobId = calls[0]?.opts.jobId ?? "";
    expect(jobId).toBe("update-13");
    expect(/^\d+$/.test(jobId)).toBe(false);
    expect(jobId.includes(":")).toBe(false);
  });

  it("доставка outbox ставится без jobId", async () => {
    const { calls, queue } = fakeQueue();
    await enqueueOutboxDelivery(queue, "update");

    expect(calls[0]?.name).toBe(JOB_DELIVER);
    expect(calls[0]?.opts.jobId).toBeUndefined();
  });
});
