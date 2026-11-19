import jsonLogic from "json-logic-js";
import type { Catalog } from "../catalog.js";
import type { Scenario } from "./scenario.js";

// Ответы пользователя: choice/confirm — строка, multi — массив строк.
export type Answers = Readonly<Record<string, string | readonly string[]>>;
export type Conditions = Record<string, boolean>;

// Условия — JSONLogic, а не eval: из контента код не исполняется.
// Возвращает только объявленные в сценарии условия.
export function evaluateConditions(scenario: Scenario, answers: Answers): Conditions {
  const data = { answers };
  const result: Conditions = {};
  for (const [key, def] of Object.entries(scenario.conditions ?? {})) {
    let value = false;
    try {
      value = Boolean(jsonLogic.apply(def.when, data));
    } catch {
      value = false;
    }
    result[key] = value;
  }
  return result;
}

// Дополняет результат всеми 13 условиями каталога (необъявленные = false).
export function evaluateConditionsForCatalog(
  scenario: Scenario,
  catalog: Catalog,
  answers: Answers,
): Conditions {
  const partial = evaluateConditions(scenario, answers);
  const result: Conditions = {};
  for (const key of catalog.conditions) {
    result[key] = partial[key] ?? false;
  }
  return result;
}
