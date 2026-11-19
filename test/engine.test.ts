import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCatalog, type Catalog } from "../src/catalog.js";
import { buildChecklist, itemsByGroup, splitRequired } from "../src/engine/checklist.js";
import { evaluateConditionsForCatalog, type Conditions } from "../src/engine/conditions.js";
import { progress } from "../src/engine/progress.js";
import { renderStep } from "../src/engine/render.js";
import { loadScenario, type Scenario } from "../src/engine/scenario.js";
import { initialState, transition, type AnswerValue, type SessionState } from "../src/engine/transition.js";

const catalogPath = path.join(process.cwd(), "content", "catalog.json");
const scenarioPath = path.join(process.cwd(), "content", "scenarios", "example.yaml");

let catalog: Catalog;
let scenario: Scenario;

beforeAll(() => {
  catalog = loadCatalog(catalogPath);
  scenario = loadScenario(scenarioPath, catalog);
});

function walk(answers: Array<[string, AnswerValue]>): SessionState {
  let state = initialState(scenario);
  for (const [stepId, value] of answers) {
    const result = transition(scenario, state, { type: "answer", stepId, value });
    expect(result.status, `шаг ${stepId}`).toBe("ok");
    state = result.state;
  }
  return state;
}

const FULL_WALK: Array<[string, AnswerValue]> = [
  ["who", "person"],
  ["debt", "over_500k"],
  ["overdue", "yes"],
  ["property", ["flat"]],
  ["income", ["salary"]],
  ["credits", ["cards"]],
  ["deals", "no"],
  ["marital", "married"],
  ["children", "yes"],
];

describe("движок: переходы", () => {
  it("проходит весь путь до результата", () => {
    const state = walk(FULL_WALK);
    expect(state.currentStep).toBe("result");
    expect(state.history).toHaveLength(FULL_WALK.length);
  });

  it("«Назад» возвращает на предыдущий шаг, ответ сохраняется", () => {
    let state = walk([["who", "person"], ["debt", "over_500k"]]);
    expect(state.currentStep).toBe("overdue");
    const back = transition(scenario, state, { type: "back" });
    expect(back.status).toBe("ok");
    expect(back.state.currentStep).toBe("debt");
    expect(back.state.answers["who"]).toBe("person");
  });

  it("«Заново» очищает ответы", () => {
    const state = walk([["who", "person"], ["debt", "over_500k"]]);
    const restarted = transition(scenario, state, { type: "restart" });
    expect(restarted.state.answers).toEqual({});
    expect(restarted.state.currentStep).toBe(scenario.start);
  });

  it("устаревшее событие — noop, состояние не меняется", () => {
    const state = walk([["who", "person"]]);
    const result = transition(scenario, state, { type: "answer", stepId: "who", value: "ip" });
    expect(result.status).toBe("noop");
    expect(result.state).toBe(state);
  });

  it("exclusive-вариант в multi снимает остальные", () => {
    const state = walk([
      ["who", "person"],
      ["debt", "over_500k"],
      ["overdue", "yes"],
      ["property", ["flat", "none"]],
    ]);
    expect(state.answers["property"]).toEqual(["none"]);
  });
});

describe("движок: условия", () => {
  it("возвращает все 13 условий каталога", () => {
    const state = walk(FULL_WALK);
    const conditions = evaluateConditionsForCatalog(scenario, catalog, state.answers);
    expect(Object.keys(conditions)).toHaveLength(13);
    expect(conditions["spouse"]).toBe(true);
    expect(conditions["children"]).toBe(true);
    expect(conditions["creditCards"]).toBe(true);
    expect(conditions["officialWork"]).toBe(true);
    expect(conditions["mortgage"]).toBe(false);
  });
});

describe("движок: чек-лист", () => {
  it("собирает группы и совпадает по счёту", () => {
    const state = walk(FULL_WALK);
    const conditions: Conditions = evaluateConditionsForCatalog(scenario, catalog, state.answers);
    const checklist = buildChecklist(catalog, scenario, conditions);

    // always=13 + spouse=6 + children=1 + creditCards=1 + officialWork=1 = 22
    expect(checklist.summary.required).toBe(22);
    expect(checklist.summary.lawyer).toBe(9);
    expect(checklist.summary.notNeeded).toBe(15);
    expect(itemsByGroup(checklist, "required")).toHaveLength(22);
  });

  it("manual-документы не попадают в обязательные", () => {
    const state = walk(FULL_WALK);
    const conditions = evaluateConditionsForCatalog(scenario, catalog, state.answers);
    const checklist = buildChecklist(catalog, scenario, conditions);
    const requiredCodes = new Set(itemsByGroup(checklist, "required").map((item) => item.code));
    for (const item of itemsByGroup(checklist, "lawyer")) {
      expect(requiredCodes.has(item.code)).toBe(false);
    }
  });

  it("прогрессивное раскрытие режет только обязательные", () => {
    const state = walk(FULL_WALK);
    const conditions = evaluateConditionsForCatalog(scenario, catalog, state.answers);
    const checklist = buildChecklist(catalog, scenario, conditions);
    const { first, rest } = splitRequired(checklist, 6);
    expect(first).toHaveLength(6);
    expect(first.length + rest.length).toBe(checklist.summary.required);
  });
});

describe("движок: прогресс и рендер", () => {
  it("остаток считается по кратчайшему пути", () => {
    expect(progress(scenario, "who").remaining).toBe(9);
    expect(progress(scenario, "who").percent).toBe(0);
    expect(progress(scenario, "children").remaining).toBe(1);
  });

  it("confirm рисует да/нет/не знаю", () => {
    const view = renderStep({ id: "c", type: "confirm", text: "?" });
    expect(view.options.map((option) => option.id)).toEqual(["yes", "no", "unknown"]);
  });
});
