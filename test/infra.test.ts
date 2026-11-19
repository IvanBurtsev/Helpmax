import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { readMigrations, runMigrations, type Migration, type MigrationClient } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

// Подменный клиент БД: помнит применённые версии и выполненные запросы.
class FakeClient implements MigrationClient {
  readonly applied = new Set<string>();
  readonly statements: string[] = [];
  failOn?: string;

  async query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }> {
    if (text.startsWith("create table if not exists schema_migrations")) return { rows: [] };
    if (text === "select version from schema_migrations") {
      return { rows: [...this.applied].map((version) => ({ version })) };
    }
    if (text === "begin" || text === "commit" || text === "rollback") return { rows: [] };
    if (text.startsWith("insert into schema_migrations")) {
      this.applied.add(String(values?.[0]));
      return { rows: [] };
    }
    if (this.failOn && text === this.failOn) throw new Error("boom");
    this.statements.push(text);
    return { rows: [] };
  }
}

const a: Migration = { version: "0001_a", sql: "create table a(id int)" };
const b: Migration = { version: "0002_b", sql: "create table b(id int)" };

describe("миграции", () => {
  it("применяет новые по порядку и пропускает уже применённые", async () => {
    const client = new FakeClient();

    expect(await runMigrations(client, [a, b])).toEqual(["0001_a", "0002_b"]);
    expect(client.statements).toEqual([a.sql, b.sql]);

    // Повторный запуск ничего не выполняет.
    expect(await runMigrations(client, [a, b])).toEqual([]);
    expect(client.statements).toEqual([a.sql, b.sql]);
  });

  it("откатывает и падает на ошибке миграции", async () => {
    const client = new FakeClient();
    client.failOn = b.sql;

    await expect(runMigrations(client, [a, b])).rejects.toThrow("0002_b");
    expect(client.applied.has("0001_a")).toBe(true);
    expect(client.applied.has("0002_b")).toBe(false);
  });

  it("читает файлы миграций из репозитория", () => {
    const migrations = readMigrations(path.join(process.cwd(), "migrations"));
    expect(migrations.map((migration) => migration.version)).toContain("0001_init");
    expect(migrations[0]?.sql.length).toBeGreaterThan(0);
  });

  it("db/schema.sql и migrations/0001_init.sql не расходятся", () => {
    const normalize = (text: string): string =>
      text
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .trim();
    const schema = fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
    const init = fs.readFileSync(path.join(process.cwd(), "migrations", "0001_init.sql"), "utf8");
    expect(normalize(init)).toBe(normalize(schema));
  });
});

describe("пул соединений", () => {
  it("создаётся без подключения к сети", () => {
    const pool = createPool("postgres://user:pass@localhost:5432/db");
    expect(pool).toBeInstanceOf(Pool);
    // Пул ленивый: соединение не открывается до первого запроса.
    expect(pool.totalCount).toBe(0);
  });
});
