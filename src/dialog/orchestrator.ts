import type { Catalog } from "../catalog.js";
import { buildChecklist, type Checklist } from "../engine/checklist.js";
import { evaluateConditionsForCatalog } from "../engine/conditions.js";
import { renderStep, type StepView } from "../engine/render.js";
import { isTerminalStep, stepsById, type Scenario } from "../engine/scenario.js";
import { initialState, transition, type AnswerValue, type SessionState } from "../engine/transition.js";

// Оркестратор диалога — чистая функция: на вход состояние сессии и событие,
// на выход новое состояние и список экранов для отправки. Ни БД, ни сети,
// ни MAX — поэтому все ветки покрываются тестами, а воркер только сохраняет
// результат и раскладывает экраны в outbox.

export type DialogEvent =
  | { type: "start" }
  | { type: "answer"; stepId: string; value: AnswerValue }
  | { type: "back" }
  | { type: "restart" };

export interface DialogStep {
  stepId: string;
  view: StepView;
  nav: { back: boolean; restart: boolean };
}

export interface DialogOutcome {
  status: "ok" | "noop";
  reason?: string;
  state: SessionState;
  steps: DialogStep[];
  /** Шаг — терминальный (чек-лист или передача юристу): сессию можно закрывать. */
  terminal: boolean;
  /** Заполняется, когда достигнут терминальный шаг-чек-лист. */
  checklist?: Checklist;
}

export interface DialogInput {
  scenario: Scenario;
  catalog: Catalog;
  /** undefined — новая сессия. */
  state?: SessionState;
  event: DialogEvent;
}

function navFor(state: SessionState): { back: boolean; restart: boolean } {
  return { back: state.history.length > 0, restart: true };
}

function present(scenario: Scenario, catalog: Catalog, state: SessionState): DialogOutcome {
  const step = stepsById(scenario).get(state.currentStep);
  if (!step) {
    return { status: "noop", reason: "step_missing", state, steps: [], terminal: false };
  }

  const outcome: DialogOutcome = {
    status: "ok",
    state,
    steps: [{ stepId: step.id, view: renderStep(step), nav: navFor(state) }],
    terminal: isTerminalStep(step),
  };

  if (step.type === "checklist") {
    const conditions = evaluateConditionsForCatalog(scenario, catalog, state.answers);
    outcome.checklist = buildChecklist(catalog, scenario, conditions);
  }

  return outcome;
}

export function runDialog(input: DialogInput): DialogOutcome {
  const state = input.state ?? initialState(input.scenario);
  const result = transition(input.scenario, state, input.event);

  if (result.status === "noop") {
    return { status: "noop", state, steps: [], terminal: false, ...(result.reason ? { reason: result.reason } : {}) };
  }
  return present(input.scenario, input.catalog, result.state);
}
