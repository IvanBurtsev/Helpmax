#!/usr/bin/env node
// Локальный симулятор диалога: тот же движок, каталог и сценарий, что в бою,
// но без Postgres, Redis и MAX. Нужен, чтобы быстро посмотреть и пощупать
// сценарий в терминале.
//
//   npm run sim
//   npm run sim -- --scenario content/scenarios/example.yaml
//
// Отвечайте номером варианта или его id. Для multi — несколько через запятую.
// «н» — назад, «r» — заново, «q» — выход.

import path from "node:path";
import { createInterface } from "node:readline";
import { loadCatalog } from "../src/catalog.js";
import { formatChecklist } from "../src/dialog/format.js";
import { runDialog, type DialogEvent } from "../src/dialog/orchestrator.js";
import type { StepOptionView } from "../src/engine/render.js";
import { loadScenario } from "../src/engine/scenario.js";
import type { SessionState } from "../src/engine/transition.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const root = process.cwd();
const catalogPath = argValue("--catalog") ?? path.join("content", "catalog.json");
const scenarioPath = argValue("--scenario") ?? path.join("content", "scenarios", "example.yaml");

const catalog = loadCatalog(path.join(root, catalogPath));
const scenario = loadScenario(path.join(root, scenarioPath), catalog);

let state: SessionState | undefined;
let options: StepOptionView[] = [];
let multiple = false;

function rule(char = "─"): void {
  console.log("\n" + char.repeat(64));
}

function show(event: DialogEvent): boolean {
  const outcome = runDialog({ scenario, catalog, ...(state ? { state } : {}), event });

  if (outcome.status === "noop") {
    console.log(`\n— так нельзя (${outcome.reason}). Попробуйте ещё раз.`);
    return false;
  }

  state = outcome.state;
  const step = outcome.steps[0];
  if (!step) return false;

  options = step.view.options;
  multiple = step.view.multiple;

  rule();
  console.log(step.view.text);
  if (options.length > 0) {
    console.log("");
    options.forEach((option, index) => console.log(`  ${index + 1}) ${option.label}`));
  }
  if (outcome.checklist) {
    console.log("");
    console.log(formatChecklist(outcome.checklist));
    console.log("\n" + outcome.checklist.disclaimer);
  }

  const hints: string[] = [];
  if (options.length > 0) hints.push("номер варианта" + (multiple ? " (можно несколько через запятую)" : ""));
  if (step.nav.back) hints.push("«н» — назад");
  if (step.nav.restart) hints.push("«r» — заново");
  hints.push("«q» — выход");
  console.log(`\n  ${hints.join(" · ")}`);
  return true;
}

function resolveToken(token: string): string | undefined {
  const value = token.trim();
  if (/^\d+$/.test(value)) return options[Number(value) - 1]?.id;
  return options.some((option) => option.id === value) ? value : undefined;
}

function toEvent(input: string): DialogEvent | undefined {
  const value = input.trim().toLowerCase();
  if (value === "" || value === "start" || value === "s") return { type: "start" };
  if (value === "n" || value === "back" || value === "назад") return { type: "back" };
  if (value === "r" || value === "restart" || value === "заново") return { type: "restart" };

  const stepId = state?.currentStep;
  if (!stepId) return undefined;

  const ids = value.split(/[,\s]+/).filter(Boolean).map(resolveToken);
  if (ids.length === 0 || ids.some((id) => id === undefined)) return undefined;

  if (multiple) return { type: "answer", stepId, value: ids as string[] };
  const first = ids[0];
  return first ? { type: "answer", stepId, value: first } : undefined;
}

console.log(`Симулятор бота «${scenario.title}» (сценарий ${scenario.code} v${scenario.version})`);
console.log(`Каталог: ${catalog.documents.length} документов, ${catalog.conditions.length} условий.`);
console.log("Документы берутся из каталога по правилам — сценарий их не дублирует.");

show({ type: "start" });

// Чтение ввода через очередь строк: корректно закрывается на EOF, поэтому
// работает и в интерактиве, и при перенаправленном вводе (тесты, демо).
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const buffered: string[] = [];
let pending: ((line: string | undefined) => void) | undefined;
let closed = false;

rl.on("line", (line) => {
  if (pending) {
    const resolve = pending;
    pending = undefined;
    resolve(line);
  } else {
    buffered.push(line);
  }
});
rl.on("close", () => {
  closed = true;
  if (pending) {
    const resolve = pending;
    pending = undefined;
    resolve(undefined);
  }
});

function nextLine(prompt: string): Promise<string | undefined> {
  process.stdout.write(prompt);
  const ready = buffered.shift();
  if (ready !== undefined) return Promise.resolve(ready);
  if (closed) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    pending = resolve;
  });
}

for (;;) {
  const line = await nextLine("\n> ");
  if (line === undefined) break;

  const value = line.trim().toLowerCase();
  if (value === "q" || value === "quit" || value === "exit" || value === "выход") break;

  const event = toEvent(line);
  if (!event) {
    console.log("Не понял. Введите номер варианта, id, «н», «r» или «q».");
    continue;
  }
  show(event);
}

rl.close();
console.log("\nПока!");
