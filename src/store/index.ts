import type { Pool } from "pg";
import { OutboxStore, type OutboxRepo } from "./outbox.js";
import { RawUpdateStore, type RawUpdatesRepo } from "./raw-updates.js";
import { ScenarioStore, type ScenariosRepo } from "./scenarios.js";
import { SessionStore, type SessionsRepo } from "./sessions.js";
import type { Queryable, QueryResultLike } from "./sql.js";

// Фасад хранилища: собирает репозитории над одним пулом. Тип `Store` —
// интерфейсы, поэтому в тестах его можно подменить без Postgres.

export interface Store {
  sessions: SessionsRepo;
  rawUpdates: RawUpdatesRepo;
  outbox: OutboxRepo;
  scenarios: ScenariosRepo;
}

// Адаптер pg-пула к минимальному Queryable.
export function poolToQueryable(pool: Pool): Queryable {
  return {
    query: async (text, values): Promise<QueryResultLike> => {
      const result = values ? await pool.query(text, values as unknown[]) : await pool.query(text);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export function createStore(pool: Pool): Store {
  const db = poolToQueryable(pool);
  return {
    sessions: new SessionStore(db),
    rawUpdates: new RawUpdateStore(db),
    outbox: new OutboxStore(db),
    scenarios: new ScenarioStore(db),
  };
}

export * from "./sql.js";
export * from "./sessions.js";
export * from "./raw-updates.js";
export * from "./outbox.js";
export * from "./scenarios.js";
export * from "./redis.js";
export * from "./memory.js";
