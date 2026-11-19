import fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Catalog } from "../catalog.js";

// Сценарий — данные (YAML), а не код. Движок интерпретирует их.
// Схема ловит структурные ошибки, validateScenario — смысловые
// (битые переходы, недостижимые шаги, опечатки в условиях).

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  next: z.string().min(1).optional(),
  exclusive: z.boolean().optional(),
});

const choiceStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("choice"),
  text: z.string().min(1),
  options: z.array(optionSchema).min(1),
  next: z.string().min(1).optional(),
});

const multiStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("multi"),
  text: z.string().min(1),
  options: z.array(optionSchema).min(1),
  min: z.number().int().min(0).optional(),
  next: z.string().min(1).optional(),
});

const confirmStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("confirm"),
  text: z.string().min(1),
  next: z.string().min(1).optional(),
});

const infoStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("info"),
  text: z.string().min(1),
  next: z.string().min(1),
});

const checklistDocumentSchema = z.union([
  z.string().min(1),
  z.object({ code: z.string().min(1), when: z.record(z.string(), z.unknown()).optional() }),
]);

const checklistStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("checklist"),
  title: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  source: z.literal("catalog").optional(),
  documents: z.array(checklistDocumentSchema).optional(),
});

const handoffStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("handoff"),
  text: z.string().min(1),
  consent_text: z.string().min(1),
});

export const stepSchema = z.discriminatedUnion("type", [
  choiceStepSchema,
  multiStepSchema,
  confirmStepSchema,
  infoStepSchema,
  checklistStepSchema,
  handoffStepSchema,
]);

const conditionDefSchema = z.object({
  when: z.record(z.string(), z.unknown()),
});

const onCompleteSchema = z.object({
  event: z.string().min(1),
  allow: z.array(z.string().min(1)).optional(),
});

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
  conditions: z.record(z.string(), conditionDefSchema).optional(),
  on_complete: z.array(onCompleteSchema).optional(),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Step = z.infer<typeof stepSchema>;
export type StepOption = z.infer<typeof optionSchema>;
export type ConditionDef = z.infer<typeof conditionDefSchema>;

export const TERMINAL_TYPES = new Set(["checklist", "handoff"]);
export const ASKING_TYPES = new Set(["choice", "multi", "confirm"]);

export function isTerminalStep(step: Step): boolean {
  return TERMINAL_TYPES.has(step.type);
}

export function isAskingStep(step: Step): boolean {
  return ASKING_TYPES.has(step.type);
}

export function stepsById(scenario: Scenario): Map<string, Step> {
  return new Map(scenario.steps.map((step) => [step.id, step]));
}

// Общий переход шага (для choice/multi/confirm может переопределяться опцией).
export function stepNext(step: Step): string | undefined {
  return "next" in step ? step.next : undefined;
}

function collectVars(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== "object") return acc;
  const record = node as Record<string, unknown>;
  if (typeof record["var"] === "string") acc.push(record["var"]);
  for (const value of Object.values(record)) collectVars(value, acc);
  return acc;
}

// Семантические проверки сценария. Возвращает список проблем (пустой = ok).
export function validateScenario(scenario: unknown, catalog?: Catalog): string[] {
  const issues: string[] = [];
  const parsed = scenarioSchema.safeParse(scenario);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`scenario: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return issues;
  }

  const def = parsed.data;
  const steps = stepsById(def);
  const edges = new Map<string, string[]>();

  for (const step of def.steps) {
    const where = `scenario ${def.code}: шаг ${step.id}`;
    const targets: string[] = [];

    const addTarget = (target: string | undefined, label: string): void => {
      if (target === undefined) return;
      if (!steps.has(target)) issues.push(`${where}: next=${target} не существует (${label})`);
      targets.push(target);
    };

    addTarget(stepNext(step), "step.next");

    if (step.type === "choice" || step.type === "multi") {
      const optionIds = new Set<string>();
      let hasUnknown = false;
      let hasExclusive = false;
      for (const option of step.options) {
        if (optionIds.has(option.id)) issues.push(`${where}: дубль варианта ${option.id}`);
        optionIds.add(option.id);
        if (option.id === "unknown" || /не знаю|другое/i.test(option.label)) hasUnknown = true;
        if (option.exclusive === true) hasExclusive = true;
        addTarget(option.next, `option ${option.id}`);
      }
      if (!hasUnknown && !hasExclusive) {
        issues.push(`${where}: нет «Не знаю»/«Другое» или exclusive-варианта`);
      }
    }

    if (step.type === "checklist") {
      const hasCatalog = step.source === "catalog";
      const hasDocuments = step.documents !== undefined;
      if (hasCatalog && hasDocuments) issues.push(`${where}: нельзя одновременно source: catalog и documents`);
      if (!hasCatalog && !hasDocuments) issues.push(`${where}: нужен source: catalog или documents`);
      if (!step.title && !step.text) issues.push(`${where}: нет title/text`);
      if (hasDocuments && catalog) {
        for (const item of step.documents ?? []) {
          const code = typeof item === "string" ? item : item.code;
          if (!catalog.byCode.has(code)) issues.push(`${where}: документ ${code} отсутствует в каталоге`);
        }
      }
    }

    if (step.type !== "checklist" && step.type !== "handoff" && targets.length === 0) {
      issues.push(`${where}: нет next и это не терминальный шаг`);
    }

    edges.set(step.id, targets);
  }

  if (!steps.has(def.start)) {
    issues.push(`scenario ${def.code}: start=${def.start} не существует`);
  } else {
    // Достижимость
    const reachable = new Set<string>();
    const stack = [def.start];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || reachable.has(id)) continue;
      reachable.add(id);
      for (const next of edges.get(id) ?? []) stack.push(next);
    }
    for (const id of steps.keys()) {
      if (!reachable.has(id)) issues.push(`scenario ${def.code}: шаг ${id} недостижим из start`);
    }
  }

  // Условия
  if (def.conditions) {
    const known = new Set(catalog?.conditions ?? []);
    for (const [key, condition] of Object.entries(def.conditions)) {
      if (catalog && !known.has(key)) {
        issues.push(`scenario ${def.code}: условие ${key} не из списка каталога`);
      }
      for (const ref of collectVars(condition.when)) {
        if (ref.startsWith("answers.")) {
          const answerId = ref.slice("answers.".length);
          if (!steps.has(answerId)) {
            issues.push(`scenario ${def.code}: условие ${key} ссылается на несуществующий ответ ${ref}`);
          }
        }
      }
    }
  }

  const checklist = def.steps.find((step) => step.type === "checklist");
  if (checklist?.type === "checklist" && checklist.source === "catalog" && !def.conditions) {
    issues.push(`scenario ${def.code}: source: catalog без conditions — все условия будут false`);
  }

  return issues;
}

export function parseScenario(raw: unknown, catalog?: Catalog): Scenario {
  const issues = validateScenario(raw, catalog);
  if (issues.length > 0) {
    throw new Error(`Некорректный сценарий:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
  return scenarioSchema.parse(raw);
}

export function loadScenario(filePath: string, catalog?: Catalog): Scenario {
  const raw = parse(fs.readFileSync(filePath, "utf8"));
  return parseScenario(raw, catalog);
}
