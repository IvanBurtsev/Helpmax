import type { Catalog } from "../catalog.js";
import { renderStep, type StepView } from "../engine/render.js";
import { isTerminalStep, stepsById, type Scenario } from "../engine/scenario.js";
import { initialState, transition, type AnswerValue, type SessionState } from "../engine/transition.js";
import type { Guides } from "../knowledge/guides.js";
import { buildInstruction, type Instruction } from "../knowledge/instruction.js";

// Оркестратор диалога — чистая функция: на вход состояние сессии и событие,
// на выход новое состояние и экраны для отправки. Ни БД, ни сети, ни MAX —
// поэтому все ветки покрываются тестами, а воркер только сохраняет результат
// и раскладывает экраны в outbox.
//
// Опросника больше нет: единственный осмысленный переход — «начать/заново»,
// который показывает инструкцию по документам. Ответы и «назад» не меняют
// состояние (asking-шагов нет), поэтому возвращают noop.

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
  /** Шаг — терминальный (инструкция): сессию можно закрывать. */
  terminal: boolean;
  /** Заполняется на шаге-инструкции: документы и как получить каждый. */
  instruction?: Instruction;
  /** Дисклеймер сценария — прикладывается к инструкции. */
  disclaimer?: string;
}

export interface DialogInput {
  scenario: Scenario;
  catalog: Catalog;
  /** Гайды «где получить»: обогащают инструкцию шагами. Необязательны. */
  guides?: Guides;
  /** undefined — новая сессия. */
  state?: SessionState;
  event: DialogEvent;
}

function navFor(): { back: boolean; restart: boolean } {
  return { back: false, restart: true };
}

// Показать текущий шаг без перехода.
function present(scenario: Scenario, catalog: Catalog, state: SessionState, guides?: Guides): DialogOutcome {
  const step = stepsById(scenario).get(state.currentStep);
  if (!step) {
    return { status: "noop", reason: "step_missing", state, steps: [], terminal: false };
  }

  const outcome: DialogOutcome = {
    status: "ok",
    state,
    steps: [{ stepId: step.id, view: renderStep(step), nav: navFor() }],
    terminal: isTerminalStep(step),
    disclaimer: scenario.disclaimer,
  };

  if (step.type === "instruction") {
    outcome.instruction = buildInstruction(catalog, guides);
  }

  return outcome;
}

export function runDialog(input: DialogInput): DialogOutcome {
  const state = input.state ?? initialState(input.scenario);
  const result = transition(input.scenario, state, input.event);

  if (result.status === "noop") {
    return { status: "noop", state, steps: [], terminal: false, ...(result.reason ? { reason: result.reason } : {}) };
  }
  return present(input.scenario, input.catalog, result.state, input.guides);
}
