import { firstRow, toNullableNumber, type Queryable } from "./sql.js";

// Входящие события. dedupe_key уникален: повторный webhook не создаёт вторую
// запись и не обрабатывается дважды. payload содержит ПД — не логируем.

export type RawUpdateStatus = "new" | "done" | "skipped" | "failed";

export interface RawUpdateRecord {
  id: string;
  dedupeKey: string;
  updateType: string;
  chatId: number | null;
  userId: number | null;
  payload: unknown;
  late: boolean;
  status: string;
}

export interface InsertRawUpdateInput {
  dedupeKey: string;
  updateType: string;
  chatId: number | null;
  userId: number | null;
  payload: unknown;
  late: boolean;
}

export interface RawUpdatesRepo {
  /** duplicate = true, если событие уже приходило (id тогда не возвращается). */
  insert(input: InsertRawUpdateInput): Promise<{ duplicate: boolean; id?: string }>;
  get(id: string): Promise<RawUpdateRecord | undefined>;
  markProcessed(id: string, status: RawUpdateStatus, error?: string): Promise<void>;
}

function toRecord(row: Record<string, unknown>): RawUpdateRecord {
  return {
    id: String(row["id"]),
    dedupeKey: String(row["dedupe_key"]),
    updateType: String(row["update_type"]),
    chatId: toNullableNumber(row["chat_id"]),
    userId: toNullableNumber(row["user_id"]),
    payload: row["payload"],
    late: row["late"] === true,
    status: String(row["status"]),
  };
}

export class RawUpdateStore implements RawUpdatesRepo {
  constructor(private readonly db: Queryable) {}

  async insert(input: InsertRawUpdateInput): Promise<{ duplicate: boolean; id?: string }> {
    const result = await this.db.query(
      `insert into raw_updates (dedupe_key, update_type, chat_id, user_id, payload, late)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (dedupe_key) do nothing
       returning id`,
      [
        input.dedupeKey,
        input.updateType,
        input.chatId,
        input.userId,
        JSON.stringify(input.payload),
        input.late,
      ],
    );
    const row = firstRow(result);
    return row ? { duplicate: false, id: String(row["id"]) } : { duplicate: true };
  }

  async get(id: string): Promise<RawUpdateRecord | undefined> {
    const result = await this.db.query(
      `select id, dedupe_key, update_type, chat_id, user_id, payload, late, status
       from raw_updates where id = $1`,
      [id],
    );
    const row = firstRow(result);
    return row ? toRecord(row) : undefined;
  }

  async markProcessed(id: string, status: RawUpdateStatus, error?: string): Promise<void> {
    await this.db.query(
      `update raw_updates
       set status = $2, processed_at = now(), error = $3
       where id = $1`,
      [id, status, error ?? null],
    );
  }
}
