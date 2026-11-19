import type { SessionState } from "../engine/transition.js";
import { firstRow, toNullableNumber, toNullableString, toNumber, type Queryable } from "./sql.js";

// Пользователи, сессии и ответы. Состояние диалога хранится целиком в
// sessions.state (jsonb), а ответы дублируются в answers для истории и аудита.

export interface UserRecord {
  id: string;
  maxUserId: number;
  chatId: number | null;
}

export interface SessionRecord {
  id: string;
  publicId: string;
  userId: string;
  scenarioCode: string;
  scenarioVersion: number;
  catalogVersion: string | null;
  state: SessionState;
  version: number;
  status: string;
  currentStep: string | null;
}

export interface UpsertUserInput {
  maxUserId: number;
  chatId: number | null;
  displayName?: string | null;
}

export interface CreateSessionInput {
  publicId: string;
  userId: string;
  scenarioCode: string;
  scenarioVersion: number;
  catalogVersion: string | null;
  state: SessionState;
  currentStep: string;
}

export interface SaveStateInput {
  id: string;
  expectedVersion: number;
  state: SessionState;
  currentStep: string;
  status: "active" | "completed" | "abandoned" | "blocked";
}

export interface AppendAnswerInput {
  sessionId: string;
  stepId: string;
  value: unknown;
}

export interface SessionsRepo {
  upsertUser(input: UpsertUserInput): Promise<UserRecord>;
  getActiveSession(userId: string): Promise<SessionRecord | undefined>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  /** Возвращает новую версию или undefined, если версия не совпала (конфликт). */
  saveState(input: SaveStateInput): Promise<number | undefined>;
  appendAnswer(input: AppendAnswerInput): Promise<void>;
  completeSession(id: string): Promise<void>;
  /** Помечает все активные сессии пользователя как abandoned (при рестарте). */
  abandonActiveSessions(userId: string): Promise<void>;
}

function toUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row["id"]),
    maxUserId: toNumber(row["max_user_id"]),
    chatId: toNullableNumber(row["chat_id"]),
  };
}

function toSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row["id"]),
    publicId: String(row["public_id"]),
    userId: String(row["user_id"]),
    scenarioCode: String(row["scenario_code"]),
    scenarioVersion: toNumber(row["scenario_version"]),
    catalogVersion: toNullableString(row["catalog_version"]),
    state: row["state"] as SessionState,
    version: toNumber(row["version"]),
    status: String(row["status"]),
    currentStep: toNullableString(row["current_step"]),
  };
}

export class SessionStore implements SessionsRepo {
  constructor(private readonly db: Queryable) {}

  async upsertUser(input: UpsertUserInput): Promise<UserRecord> {
    const result = await this.db.query(
      `insert into users (max_user_id, chat_id, display_name)
       values ($1, $2, $3)
       on conflict (max_user_id) do update
         set chat_id = coalesce(excluded.chat_id, users.chat_id),
             display_name = coalesce(excluded.display_name, users.display_name)
       returning id, max_user_id, chat_id`,
      [input.maxUserId, input.chatId, input.displayName ?? null],
    );
    const row = firstRow(result);
    if (!row) throw new Error("upsertUser: пустой ответ БД");
    return toUser(row);
  }

  async getActiveSession(userId: string): Promise<SessionRecord | undefined> {
    const result = await this.db.query(
      `select * from sessions
       where user_id = $1 and status = 'active'
       order by started_at desc
       limit 1`,
      [userId],
    );
    const row = firstRow(result);
    return row ? toSession(row) : undefined;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const result = await this.db.query(
      `insert into sessions
         (public_id, user_id, scenario_code, scenario_version, catalog_version, state, current_step)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)
       returning *`,
      [
        input.publicId,
        input.userId,
        input.scenarioCode,
        input.scenarioVersion,
        input.catalogVersion,
        JSON.stringify(input.state),
        input.currentStep,
      ],
    );
    const row = firstRow(result);
    if (!row) throw new Error("createSession: пустой ответ БД");
    return toSession(row);
  }

  async saveState(input: SaveStateInput): Promise<number | undefined> {
    const result = await this.db.query(
      `update sessions
       set state = $2::jsonb,
           current_step = $3,
           status = $4,
           version = version + 1,
           updated_at = now(),
           completed_at = case when $4 = 'completed' then now() else completed_at end
       where id = $1 and version = $5
       returning version`,
      [input.id, JSON.stringify(input.state), input.currentStep, input.status, input.expectedVersion],
    );
    const row = firstRow(result);
    return row ? toNumber(row["version"]) : undefined;
  }

  async appendAnswer(input: AppendAnswerInput): Promise<void> {
    await this.db.query(
      `insert into answers (session_id, step_id, revision, value)
       values (
         $1,
         $2,
         (select coalesce(max(revision), 0) + 1 from answers where session_id = $1 and step_id = $2),
         $3::jsonb
       )`,
      [input.sessionId, input.stepId, JSON.stringify(input.value)],
    );
  }

  async completeSession(id: string): Promise<void> {
    await this.db.query(
      `update sessions set status = 'completed', completed_at = now(), updated_at = now() where id = $1`,
      [id],
    );
  }

  async abandonActiveSessions(userId: string): Promise<void> {
    await this.db.query(
      `update sessions set status = 'abandoned', updated_at = now()
       where user_id = $1 and status = 'active'`,
      [userId],
    );
  }
}
