import type { Scenario, Step } from "./scenario.js";
import { isAskingStep, stepNext, stepsById } from "./scenario.js";

// Переход — чистая функция без I/O и без исключений: невалидное событие
// возвращает noop, а не падает. Так его можно проверять тестами без сети.

export type AnswerValue = string | string[];

export interface SessionState {
  answers: Record<string, AnswerValue>;
  currentStep: string;
  history: string[];
  flags: { disclaimerShown: boolean };
}

export type EngineEvent =
  | { type: "start" }
  | { type: "answer"; stepId: string; value: AnswerValue }
  | { type: "advance"; stepId: string }
  | { type: "back" }
  | { type: "restart" };

export type TransitionStatus = "ok" | "noop";

export interface TransitionResult {
  state: SessionState;
  status: TransitionStatus;
  reason?: string;
}

export function initialState(scenario: Scenario): SessionState {
  return {
    answers: {},
    currentStep: scenario.start,
    history: [],
    flags: { disclaimerShown: false },
  };
}

// В multi выбор exclusive-варианта («Ничего», «Не знаю») снимает остальные.
// Если выбрано несколько exclusive — оставляем последний.
function normalizeMulti(step: Step & { type: "multi" }, value: string[]): string[] {
  const exclusiveIds = new Set(step.options.filter((option) => option.exclusive === true).map((option) => option.id));
  const exclusiveChosen = value.filter((id) => exclusiveIds.has(id));
  if (exclusiveChosen.length > 0) {
    const last = exclusiveChosen[exclusiveChosen.length - 1];
    return last === undefined ? value : [last];
  }
  return value;
}

// Следующий шаг: next опции переопределяет общий next шага.
function resolveNext(step: Step, value: AnswerValue): string | undefined {
  if (step.type === "choice" || step.type === "multi") {
    const ids = Array.isArray(value) ? value : [value];
    for (const id of ids) {
      const option = step.options.find((candidate) => candidate.id === id);
      if (option?.next) return option.next;
    }
  }
  return stepNext(step);
}

function withHistory(state: SessionState, next: string, answers: Record<string, AnswerValue>): SessionState {
  return {
    ...state,
    answers,
    currentStep: next,
    history: [...state.history, state.currentStep],
  };
}

export function transition(scenario: Scenario, state: SessionState, event: EngineEvent): TransitionResult {
  const steps = stepsById(scenario);

  switch (event.type) {
    case "start":
    case "restart":
      return { state: initialState(scenario), status: "ok" };

    case "back": {
      const history = [...state.history];
      const previous = history.pop();
      if (previous === undefined) return { state, status: "noop", reason: "history_empty" };
      return { state: { ...state, currentStep: previous, history }, status: "ok" };
    }

    case "advance": {
      if (event.stepId !== state.currentStep) return { state, status: "noop", reason: "stale_event" };
      const step = steps.get(state.currentStep);
      if (!step || step.type !== "info") return { state, status: "noop", reason: "not_info_step" };
      return { state: withHistory(state, step.next, state.answers), status: "ok" };
    }

    case "answer": {
      if (event.stepId !== state.currentStep) return { state, status: "noop", reason: "stale_event" };
      const step = steps.get(state.currentStep);
      if (!step || !isAskingStep(step)) return { state, status: "noop", reason: "not_asking_step" };

      const value =
        step.type === "multi" && Array.isArray(event.value)
          ? normalizeMulti(step, event.value)
          : event.value;

      const next = resolveNext(step, value);
      if (next === undefined) return { state, status: "noop", reason: "no_next_step" };

      const answers = { ...state.answers, [step.id]: value };
      return { state: withHistory(state, next, answers), status: "ok" };
    }
  }
}
