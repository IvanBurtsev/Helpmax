import { Redis } from "ioredis";

// Redis: очередь (BullMQ), идемпотентные локи и счётчики лимитов.
// maxRetriesPerRequest: null — требование BullMQ к соединению воркера.

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

// Простой распределённый лок: SET NX PX. Возвращает true, если лок наш.
export async function acquireLock(redis: Redis, key: string, ttlMs: number): Promise<boolean> {
  const result = await redis.set(key, "1", "PX", ttlMs, "NX");
  return result === "OK";
}

export async function releaseLock(redis: Redis, key: string): Promise<void> {
  await redis.del(key);
}
