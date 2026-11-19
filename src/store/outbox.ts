import { firstRow, toNumber, type Queryable } from "./sql.js";

// Исходящие сообщения. idempotency_key уникален: повторная постановка того же
// сообщения не создаёт дубль. claim помечает пачку как «sending» и возвращает её.

export interface OutboxRecord {
  id: string;
  chatId: number;
  kind: string;
  payload: unknown;
  attempts: number;
}

export interface EnqueueInput {
  chatId: number;
  sessionId: string | null;
  kind: string;
  payload: unknown;
  idempotencyKey: string;
}

export interface MarkFailedInput {
  id: string;
  error: string;
  /** null — окончательно (dead), иначе время следующей попытки. */
  retryAt: Date | null;
}

export interface OutboxRepo {
  enqueue(input: EnqueueInput): Promise<{ inserted: boolean; id?: string }>;
  claim(limit: number): Promise<OutboxRecord[]>;
  markSent(id: string, messageId: string | null): Promise<void>;
  markFailed(input: MarkFailedInput): Promise<void>;
}

function toRecord(row: Record<string, unknown>): OutboxRecord {
  return {
    id: String(row["id"]),
    chatId: toNumber(row["chat_id"]),
    kind: String(row["kind"]),
    payload: row["payload"],
    attempts: toNumber(row["attempts"]),
  };
}

export class OutboxStore implements OutboxRepo {
  constructor(private readonly db: Queryable) {}

  async enqueue(input: EnqueueInput): Promise<{ inserted: boolean; id?: string }> {
    const result = await this.db.query(
      `insert into outbox (chat_id, session_id, kind, payload, idempotency_key)
       values ($1, $2, $3, $4::jsonb, $5)
       on conflict (idempotency_key) do nothing
       returning id`,
      [input.chatId, input.sessionId, input.kind, JSON.stringify(input.payload), input.idempotencyKey],
    );
    const row = firstRow(result);
    return row ? { inserted: true, id: String(row["id"]) } : { inserted: false };
  }

  async claim(limit: number): Promise<OutboxRecord[]> {
    const result = await this.db.query(
      `update outbox
       set status = 'sending', attempts = attempts + 1, updated_at = now()
       where id in (
         select id from outbox
         where (status = 'pending' and next_at <= now())
            or (status = 'sending' and updated_at < now() - interval '2 minutes')
         order by id
         limit $1
         for update skip locked
       )
       returning id, chat_id, kind, payload, attempts`,
      [limit],
    );
    return result.rows.map(toRecord);
  }

  async markSent(id: string, messageId: string | null): Promise<void> {
    await this.db.query(
      `update outbox
       set status = 'sent', sent_at = now(), message_id = $2, last_error = null, updated_at = now()
       where id = $1`,
      [id, messageId],
    );
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    if (input.retryAt === null) {
      await this.db.query(
        `update outbox set status = 'dead', last_error = $2, updated_at = now() where id = $1`,
        [input.id, input.error],
      );
      return;
    }
    await this.db.query(
      `update outbox
       set status = 'pending', next_at = $2, last_error = $3, updated_at = now()
       where id = $1`,
      [input.id, input.retryAt, input.error],
    );
  }
}
