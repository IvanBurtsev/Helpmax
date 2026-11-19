import type { Scenario, Step } from "./scenario.js";
import { isTerminalStep, stepNext, stepsById } from "./scenario.js";

function successors(step: Step): string[] {
  const out: string[] = [];
  const next = stepNext(step);
  if (next) out.push(next);
  if (step.type === "choice" || step.type === "multi") {
    for (const option of step.options) {
      if (option.next) out.push(option.next);
    }
  }
  return out;
}

// Минимальное число шагов от `from` до ближайшего терминального (BFS).
export function minStepsToTerminal(scenario: Scenario, from: string): number {
  const steps = stepsById(scenario);
  const queue: Array<{ id: string; depth: number }> = [{ id: from, depth: 0 }];
  const seen = new Set<string>([from]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const step = steps.get(current.id);
    if (!step) continue;
    if (isTerminalStep(step)) return current.depth;
    for (const next of successors(step)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push({ id: next, depth: current.depth + 1 });
      }
    }
  }
  return Number.POSITIVE_INFINITY;
}

export interface Progress {
  remaining: number;
  total: number;
  percent: number;
}

// Прогресс по кратчайшему оставшемуся пути: «Осталось примерно N вопросов».
export function progress(scenario: Scenario, currentStep: string): Progress {
  const remaining = minStepsToTerminal(scenario, currentStep);
  const total = minStepsToTerminal(scenario, scenario.start);

  if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) {
    return { remaining: 0, total: 0, percent: 100 };
  }

  const done = total - remaining;
  const percent = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  return { remaining, total, percent };
}
