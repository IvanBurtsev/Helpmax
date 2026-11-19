import fs from "node:fs";
import path from "node:path";

// Простой раннер миграций: применяет `migrations/*.sql` по порядку, каждый файл
// в своей транзакции, и отмечает применённые в `schema_migrations`.
// Без внешних зависимостей и без «магии» — легко прочитать и проверить.

export interface QueryResultLike {
  rows: unknown[];
}

export interface MigrationClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
}

export interface Migration {
  version: string;
  sql: string;
}

// Имя файла: 0001_init.sql → version = «0001_init».
const FILE_PATTERN = /^\d{3,}_[a-z0-9_]+\.sql$/i;

export function readMigrations(dir: string): Migration[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => FILE_PATTERN.test(name))
    .sort()
    .map((name) => ({
      version: name.replace(/\.sql$/i, ""),
      sql: fs.readFileSync(path.join(dir, name), "utf8"),
    }));
}

const ENSURE_TABLE = `create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
)`;

export async function runMigrations(client: MigrationClient, migrations: Migration[]): Promise<string[]> {
  await client.query(ENSURE_TABLE);

  const existing = await client.query("select version from schema_migrations");
  const applied = new Set(existing.rows.map((row) => String((row as { version: unknown }).version)));

  const justApplied: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await client.query("begin");
    try {
      await client.query(migration.sql);
      await client.query("insert into schema_migrations (version) values ($1)", [migration.version]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Миграция ${migration.version} не применилась: ${reason}`);
    }
    justApplied.push(migration.version);
  }
  return justApplied;
}
