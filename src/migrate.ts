import path from "node:path";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { readMigrations, runMigrations, type MigrationClient } from "./db/migrate.js";
import { loadDotEnv } from "./env.js";

// Применение миграций: `npm run migrate` (dev) или `node dist/migrate.js` (прод).

loadDotEnv();
const config = loadConfig();

if (!config.DATABASE_URL) {
  console.error("DATABASE_URL не задан — миграции некуда применять. Заполните .env.");
  process.exit(1);
}

const migrations = readMigrations(path.join(process.cwd(), "migrations"));
if (migrations.length === 0) {
  console.error("В migrations/ нет ни одного файла — нечего применять.");
  process.exit(1);
}

const pool = createPool(config.DATABASE_URL);
const connection = await pool.connect();

try {
  // Миграции должны идти по одному соединению, иначе транзакция не будет общей.
  const client: MigrationClient = {
    query: async (text, values) => {
      const result = values ? await connection.query(text, values as unknown[]) : await connection.query(text);
      return { rows: result.rows };
    },
  };

  const applied = await runMigrations(client, migrations);
  console.log(applied.length > 0 ? `Применено миграций: ${applied.join(", ")}` : "Новых миграций нет.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  connection.release();
  await pool.end();
}
