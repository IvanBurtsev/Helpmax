import type { Step } from "./scenario.js";

// Промежуточное представление шага для отправки в MAX: без привязки к SDK,
// чтобы рендер можно было тестировать без сети.

export interface StepOptionView {
  id: string;
  label: string;
}

export interface StepView {
  stepId: string;
  type: Step["type"];
  text: string;
  multiple: boolean;
  options: StepOptionView[];
  terminal: boolean;
}

// confirm движок рисует сам: строго да/нет/не знаю.
export const CONFIRM_OPTIONS: readonly StepOptionView[] = [
  { id: "yes", label: "Да" },
  { id: "no", label: "Нет" },
  { id: "unknown", label: "Не знаю" },
];

export function renderStep(step: Step): StepView {
  switch (step.type) {
    case "choice":
      return {
        stepId: step.id,
        type: step.type,
        text: step.text,
        multiple: false,
        options: step.options.map((option) => ({ id: option.id, label: option.label })),
        terminal: false,
      };
    case "multi":
      return {
        stepId: step.id,
        type: step.type,
        text: step.text,
        multiple: true,
        options: step.options.map((option) => ({ id: option.id, label: option.label })),
        terminal: false,
      };
    case "confirm":
      return {
        stepId: step.id,
        type: step.type,
        text: step.text,
        multiple: false,
        options: [...CONFIRM_OPTIONS],
        terminal: false,
      };
    case "info":
      return {
        stepId: step.id,
        type: step.type,
        text: step.text,
        multiple: false,
        options: [],
        terminal: false,
      };
    case "checklist":
      return {
        stepId: step.id,
        type: step.type,
        text: step.title ?? step.text ?? "",
        multiple: false,
        options: [],
        terminal: true,
      };
    case "handoff":
      return {
        stepId: step.id,
        type: step.type,
        text: step.text,
        multiple: false,
        options: [],
        terminal: true,
      };
  }
}
