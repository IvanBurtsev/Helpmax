import { randomUUID } from "node:crypto";
import type { Scenario } from "../engine/scenario.js";
import type { Store } from "./index.js";
import type { EnqueueInput, MarkFailedInput, OutboxRecord, OutboxRepo } from "./outbox.js";
import type {
  InsertRawUpdateInput,
  RawUpdateRecord,
  RawUpdatesRepo,
  RawUpdateStatus,
} from "./raw-updates.js";
import type { ScenariosRepo } from "./scenarios.js";
import type {
  AppendAnswerInput,
  CreateSessionInput,
  SaveStateInput,
  SessionRecord,
  SessionsRepo,
  UpsertUserInput,
  UserRecord,
} from "./sessions.js";

// Хранилище в памяти: те же интерфейсы `Store`, что у Postgres, но без базы.
// Нужно для локального запуска бота через long polling (не требуется
// Postgres/Redis) и для тестов. Продуктовый код не знает, где лежат данные.

interface MemoryUser {
  id: string;
  maxUserId: number;
  chatId: number | null;
}

interface MemorySession extends SessionRecord {
  /** Порядок создания: активной считается последняя сессия. */
  startedSeq: number;
  answers: Array<{ stepId: string; revision: number; value: unknown }>;
}

export class MemorySessionStore implements SessionsRepo {
  private readonly usersByMaxId = new Map<number, MemoryUser>();
  private readonly sessions = new Map<string, MemorySession>();
  private seq = 0;

  async upsertUser(input: UpsertUserInput): Promise<UserRecord> {
    const existing = this.usersByMaxId.get(input.maxUserId);
    if (existing) {
      if (input.chatId !== null) existing.chatId = input.chatId;
      return { id: existing.id, maxUserId: existing.maxUserId, chatId: existing.chatId };
    }
    const user: MemoryUser = { id: randomUUID(), maxUserId: input.maxUserId, chatId: input.chatId };
    this.usersByMaxId.set(input.maxUserId, user);
    return { id: user.id, maxUserId: user.maxUserId, chatId: user.chatId };
  }

  async getActiveSession(userId: string): Promise<SessionRecord | undefined> {
    let best: MemorySession | undefined;
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || session.status !== "active") continue;
      if (!best || session.startedSeq > best.startedSeq) best = session;
    }
    return best ? copySession(best) : undefined;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    this.seq += 1;
    const session: MemorySession = {
      id: randomUUID(),
      publicId: input.publicId,
      userId: input.userId,
      scenarioCode: input.scenarioCode,
      scenarioVersion: input.scenarioVersion,
      catalogVersion: input.catalogVersion,
      state: structuredClone(input.state),
      version: 1,
      status: "active",
      currentStep: input.currentStep,
      startedSeq: this.seq,
      answers: [],
    };
    this.sessions.set(session.id, session);
    return copySession(session);
  }

  async saveState(input: SaveStateInput): Promise<number | undefined> {
    const session = this.sessions.get(input.id);
    if (!session || session.version !== input.expectedVersion) return undefined;
    session.state = structuredClone(input.state);
    session.currentStep = input.currentStep;
    session.status = input.status;
    session.version += 1;
    return session.version;
  }

  async appendAnswer(input: AppendAnswerInput): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    const revision =
      session.answers.reduce(
        (max, answer) => (answer.stepId === input.stepId ? Math.max(max, answer.revision) : max),
        0,
      ) + 1;
    session.answers.push({ stepId: input.stepId, revision, value: structuredClone(input.value) });
  }

  async completeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.status = "completed";
  }

  async abandonActiveSessions(userId: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.status === "active") session.status = "abandoned";
    }
  }
}

export class MemoryRawUpdateStore implements RawUpdatesRepo {
  private readonly byId = new Map<string, RawUpdateRecord>();
  private readonly byDedupeKey = new Map<string, string>();

  async insert(input: InsertRawUpdateInput): Promise<{ duplicate: boolean; id?: string }> {
    if (this.byDedupeKey.has(input.dedupeKey)) return { duplicate: true };
    const id = randomUUID();
    this.byId.set(id, {
      id,
      dedupeKey: input.dedupeKey,
      updateType: input.updateType,
      chatId: input.chatId,
      userId: input.userId,
      payload: input.payload,
      late: input.late,
      status: "new",
    });
    this.byDedupeKey.set(input.dedupeKey, id);
    return { duplicate: false, id };
  }

  async get(id: string): Promise<RawUpdateRecord | undefined> {
    return this.byId.get(id);
  }

  async markProcessed(id: string, status: RawUpdateStatus, _error?: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.status = status;
  }
}

interface MemoryOutboxRow {
  id: string;
  chatId: number;
  kind: string;
  payload: unknown;
  idempotencyKey: string;
  status: "pending" | "sending" | "sent" | "dead";
  attempts: number;
  nextAt: number;
  updatedAt: number;
}

const STUCK_SENDING_MS = 2 * 60 * 1000;

export class MemoryOutboxStore implements OutboxRepo {
  private readonly rows: MemoryOutboxRow[] = [];
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  async enqueue(input: EnqueueInput): Promise<{ inserted: boolean; id?: string }> {
    if (this.byIdempotencyKey.has(input.idempotencyKey)) return { inserted: false };
    const id = randomUUID();
    const at = this.now();
    this.rows.push({
      id,
      chatId: input.chatId,
      kind: input.kind,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      status: "pending",
      attempts: 0,
      nextAt: at,
      updatedAt: at,
    });
    this.byIdempotencyKey.set(input.idempotencyKey, id);
    return { inserted: true, id };
  }

  async claim(limit: number): Promise<OutboxRecord[]> {
    const at = this.now();
    const claimed: OutboxRecord[] = [];
    for (const row of this.rows) {
      if (claimed.length >= limit) break;
      const ready =
        (row.status === "pending" && row.nextAt <= at) ||
        (row.status === "sending" && row.updatedAt < at - STUCK_SENDING_MS);
      if (!ready) continue;
      row.status = "sending";
      row.attempts += 1;
      row.updatedAt = at;
      claimed.push({ id: row.id, chatId: row.chatId, kind: row.kind, payload: row.payload, attempts: row.attempts });
    }
    return claimed;
  }

  async markSent(id: string, _messageId: string | null): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) {
      row.status = "sent";
      row.updatedAt = this.now();
    }
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === input.id);
    if (!row) return;
    if (input.retryAt === null) {
      row.status = "dead";
    } else {
      row.status = "pending";
      row.nextAt = input.retryAt.getTime();
    }
    row.updatedAt = this.now();
  }
}

function copySession(session: MemorySession): SessionRecord {
  return {
    id: session.id,
    publicId: session.publicId,
    userId: session.userId,
    scenarioCode: session.scenarioCode,
    scenarioVersion: session.scenarioVersion,
    catalogVersion: session.catalogVersion,
    state: structuredClone(session.state),
    version: session.version,
    status: session.status,
    currentStep: session.currentStep,
  };
}

// В памяти версии сценария храним просто множеством «code@version»: внешних
// ключей здесь нет, важно лишь поведение, совпадающее с Postgres.
export class MemoryScenarioStore implements ScenariosRepo {
  private readonly registered = new Set<string>();

  async register(scenario: Scenario): Promise<void> {
    this.registered.add(`${scenario.code}@${scenario.version}`);
  }

  has(code: string, version: number): boolean {
    return this.registered.has(`${code}@${version}`);
  }
}

export function createMemoryStore(now: () => number = Date.now): Store {
  return {
    sessions: new MemorySessionStore(),
    rawUpdates: new MemoryRawUpdateStore(),
    outbox: new MemoryOutboxStore(now),
    scenarios: new MemoryScenarioStore(),
  };
}
