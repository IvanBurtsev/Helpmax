import type { MaxClient } from "../max/client.js";
import type { OutboxRepo, OutboxRecord } from "../store/outbox.js";
import type { EditPayload, MessagePayload } from "./screens.js";

// Доставка исходящих сообщений из outbox через MAX. Все сетевые вызовы MAX
// проходят здесь — значит, сюда же применимы лимит частоты и повторы из
// транспорта. Задача чистая по отношению к БД: репозиторий передаётся снаружи,
// поэтому логику повторов можно проверить подменным outbox.

/** Некорректное задание: повторять бессмысленно, помечаем dead сразу. */
export class UnsupportedOutboxKindError extends Error {
  constructor(readonly kind: string) {
    super(`Неизвестный kind задания outbox: ${kind}`);
    this.name = "UnsupportedOutboxKindError";
  }
}

export interface DeliverDeps {
  outbox: OutboxRepo;
  max: Pick<MaxClient, "sendMessage" | "editMessage">;
  limit?: number;
  now?: () => number;
  maxAttempts?: number;
}

export interface DeliverResult {
  sent: number;
  failed: number;
}

const MAX_BACKOFF_MS = 60_000;

// Экспоненциальная задержка повтора с потолком: 2с, 4с, 8с … не больше минуты.
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts) * 1000, MAX_BACKOFF_MS);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Отправляет одну запись и возвращает mid отправленного сообщения (или null).
async function deliver(deps: DeliverDeps, record: OutboxRecord): Promise<string | null> {
  switch (record.kind) {
    case "message": {
      const payload = record.payload as MessagePayload;
      const message = await deps.max.sendMessage({
        chatId: payload.chatId,
        text: payload.text,
        ...(payload.keyboard ? { keyboard: payload.keyboard } : {}),
        ...(payload.format ? { format: payload.format } : {}),
      });
      return message.body.mid ?? null;
    }
    case "edit": {
      const payload = record.payload as EditPayload;
      await deps.max.editMessage({
        messageId: payload.messageId,
        ...(payload.text !== undefined ? { text: payload.text } : {}),
        ...(payload.keyboard !== undefined ? { keyboard: payload.keyboard } : {}),
      });
      return null;
    }
    default:
      throw new UnsupportedOutboxKindError(record.kind);
  }
}

// Забирает пачку pending-заданий и пытается их отправить. Успех — sent,
// ошибка — повтор с задержкой, пока не исчерпаны попытки, затем dead.
export async function deliverOutbox(deps: DeliverDeps): Promise<DeliverResult> {
  const now = deps.now ?? Date.now;
  const maxAttempts = deps.maxAttempts ?? 5;
  const records = await deps.outbox.claim(deps.limit ?? 20);

  let sent = 0;
  let failed = 0;

  for (const record of records) {
    try {
      const messageId = await deliver(deps, record);
      await deps.outbox.markSent(record.id, messageId);
      sent += 1;
    } catch (error) {
      const fatal = error instanceof UnsupportedOutboxKindError || record.attempts >= maxAttempts;
      const retryAt = fatal ? null : new Date(now() + retryDelayMs(record.attempts));
      await deps.outbox.markFailed({ id: record.id, error: describe(error), retryAt });
      failed += 1;
    }
  }

  return { sent, failed };
}
