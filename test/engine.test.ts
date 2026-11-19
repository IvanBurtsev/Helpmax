import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { renderStep } from "../src/engine/render.js";
import { loadScenario, type Scenario } from "../src/engine/scenario.js";
import { initialState, transition } from "../src/engine/transition.js";

// Движок после переделки: опросника нет, есть один терминальный шаг-инструкция
// и переход «начать/заново». Всё проверяется без сети.

const scenarioPath = path.join(process.cwd(), "content", "scenarios", "example.yaml");

let scenario: Scenario;

beforeAll(() => {
  scenario = loadScenario(scenarioPath);
});

describe("движок: переходы", () => {
  it("сценарий стартует с шага-инструкции", () => {
    expect(scenario.start).toBe("instruction");
    expect(initialState(scenario)).toEqual({ currentStep: "instruction" });
  });

  it("«Начать» и «Заново» сбрасывают сессию на инструкцию", () => {
    const state = { currentStep: "что-то-другое" };
    expect(transition(scenario, state, { type: "start" }).state.currentStep).toBe("instruction");
    expect(transition(scenario, state, { type: "restart" }).state.currentStep).toBe("instruction");
  });

  it("устаревшее событие ответа — noop, состояние не меняется", () => {
    const state = initialState(scenario);
    const result = transition(scenario, state, { type: "answer", stepId: "who", value: "person" });
    expect(result.status).toBe("noop");
    expect(result.state).toBe(state);
  });

  it("«Назад» — noop: истории шагов больше нет", () => {
    const state = initialState(scenario);
    const result = transition(scenario, state, { type: "back" });
    expect(result.status).toBe("noop");
    expect(result.state).toBe(state);
  });
});

describe("движок: рендер", () => {
  it("шаг-инструкция терминальный, без вариантов ответа", () => {
    const step = scenario.steps[0];
    if (!step) throw new Error("нет шага");
    const view = renderStep(step);
    expect(view.terminal).toBe(true);
    expect(view.options).toHaveLength(0);
    expect(view.text).toBe("Как получить документы");
  });
});
