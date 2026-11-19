import { Queue } from "bullmq";
import type { Redis } from "ioredis";

// Очереди BullMQ. `updates` — входящие события, `outbox` — отправка сообщений.
// Соединение передаётся снаружи: в проде у воркеров и у сервера оно своё.

export const QUEUE_UPDATES = "updates";
export const QUEUE_OUTBOX = "outbox";

export const JOB_UPDATE = "update";
export const JOB_DELIVER = "deliver";
export const JOB_SWEEP = "sweep";

export interface UpdateJobData {
  rawUpdateId: string;
}

export interface OutboxJobData {
  reason: string;
}

export function createUpdatesQueue(connection: Redis): Queue<UpdateJobData> {
  return new Queue<UpdateJobData>(QUEUE_UPDATES, { connection });
}

export function createOutboxQueue(connection: Redis): Queue<OutboxJobData> {
  return new Queue<OutboxJobData>(QUEUE_OUTBOX, { connection });
}

// Постановка события: jobId = id записи, поэтому повторный webhook не создаёт
// вторую задачу, а BullMQ сам отбросит дубль.
export async function enqueueUpdate(queue: Queue<UpdateJobData>, rawUpdateId: string): Promise<void> {
  await queue.add(JOB_UPDATE, { rawUpdateId }, { jobId: rawUpdateId, removeOnComplete: 1000, removeOnFail: 5000 });
}

export async function enqueueOutboxDelivery(queue: Queue<OutboxJobData>, reason: string): Promise<void> {
  await queue.add(JOB_DELIVER, { reason }, { removeOnComplete: true, removeOnFail: 100 });
}
