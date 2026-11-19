import fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// Сценарий — данные (YAML), а не код. Опросника больше нет: сценарий описывает
// единственный терминальный шаг-инструкцию «как получить документы». Состав
// документов живёт в каталоге, шаги получения — в гайдах; сценарий их не
// дублирует. Схема ловит структурные ошибки, validateScenario — смысловые.

const instructionStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("instruction"),
  title: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
});

export const stepSchema = z.discriminatedUnion("type", [instructionStepSchema]);

export const scenarioSchema = z.object({
  code: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().min(1),
  status: z.enum(["draft", "published", "archived"]),
  catalog: z.string().optional(),
  catalogVersion: z.string().optional(),
  disclaimer: z.string().min(1),
  start: z.string().min(1),
  steps: z.array(stepSchema).min(1).max(40),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Step = z.infer<typeof stepSchema>;

const TERMINAL_TYPES = new Set(["instruction"]);

export function isTerminalStep(step: Step): boolean {
  return TERMINAL_TYPES.has(step.type);
}

export function stepsById(scenario: Scenario): Map<string, Step> {
  return new Map(scenario.steps.map((step) => [step.id, step]));
}

// Семантические проверки сценария. Возвращает список проблем (пустой = ok).
export function validateScenario(scenario: unknown): string[] {
  const issues: string[] = [];
  const parsed = scenarioSchema.safeParse(scenario);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`scenario: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return issues;
  }

  const def = parsed.data;
  const seen = new Set<string>();
  for (const step of def.steps) {
    if (seen.has(step.id)) issues.push(`scenario ${def.code}: дубль шага ${step.id}`);
    seen.add(step.id);
    if (!step.title && !step.text) issues.push(`scenario ${def.code}: шаг ${step.id}: нет title/text`);
  }

  if (!seen.has(def.start)) {
    issues.push(`scenario ${def.code}: start=${def.start} не существует`);
  }

  return issues;
}

export function parseScenario(raw: unknown): Scenario {
  const issues = validateScenario(raw);
  if (issues.length > 0) {
    throw new Error(`Некорректный сценарий:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
  return scenarioSchema.parse(raw);
}

export function loadScenario(filePath: string): Scenario {
  const raw = parse(fs.readFileSync(filePath, "utf8"));
  return parseScenario(raw);
}
