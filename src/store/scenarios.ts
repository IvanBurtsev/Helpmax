import type { Scenario } from "../engine/scenario.js";
import type { Queryable } from "./sql.js";

// Сценарии — версионируемый контент. Строка (code, version) обязана
// существовать до создания сессии: на неё ссылается sessions по внешнему
// ключу. Поэтому загруженный сценарий регистрируется при старте (upsert).

export interface ScenariosRepo {
  /** Регистрирует версию сценария, чтобы сессии могли на неё ссылаться. */
  register(scenario: Scenario): Promise<void>;
}

export class ScenarioStore implements ScenariosRepo {
  constructor(private readonly db: Queryable) {}

  async register(scenario: Scenario): Promise<void> {
    // status и published_at при конфликте не трогаем: публикация — решение
    // контент-команды, а не побочный эффект запуска воркера.
    await this.db.query(
      `insert into scenarios (code, version, title, status, definition, catalog_version, disclaimer)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       on conflict (code, version) do update
         set title = excluded.title,
             definition = excluded.definition,
             catalog_version = excluded.catalog_version,
             disclaimer = excluded.disclaimer`,
      [
        scenario.code,
        scenario.version,
        scenario.title,
        scenario.status,
        JSON.stringify(scenario),
        scenario.catalogVersion ?? null,
        scenario.disclaimer,
      ],
    );
  }
}
