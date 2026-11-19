import type { Scenario } from "./scenario.js";

// Переход — чистая функция без I/O и без исключений. Опросника нет, поэтому
// единственный осмысленный переход — «начать/заново»: он сбрасывает сессию на
// шаг-инструкцию. Любое другое событие (устаревшая кнопка ответа, «назад»)
// возвращает noop и не меняет состояние.

export type AnswerValue = string | string[];

export interface SessionState {
  currentStep: string;
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
  return { currentStep: scenario.start };
}

export function transition(scenario: Scenario, state: SessionState, event: EngineEvent): TransitionResult {
  switch (event.type) {
    case "start":
    case "restart":
      return { state: initialState(scenario), status: "ok" };
    default:
      return { state, status: "noop", reason: "unsupported_event" };
  }
}
