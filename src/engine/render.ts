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

// Единственный тип шага — терминальная инструкция: без вариантов ответа.
export function renderStep(step: Step): StepView {
  return {
    stepId: step.id,
    type: step.type,
    text: step.title ?? step.text ?? "",
    multiple: false,
    options: [],
    terminal: true,
  };
}
