#!/usr/bin/env node
// Локальный просмотр инструкции: тот же каталог, гайды и сценарий, что в бою,
// но без Postgres, Redis и MAX. Печатает то, что бот покажет клиенту после
// «Начать» — сообщение за сообщением, как их разобьёт MAX.
//
//   npm run sim
//   npm run sim -- --scenario content/scenarios/example.yaml

import path from "node:path";
import { loadCatalog } from "../src/catalog.js";
import { formatInstruction } from "../src/dialog/format.js";
import { runDialog } from "../src/dialog/orchestrator.js";
import { loadScenario } from "../src/engine/scenario.js";
import { loadGuides } from "../src/knowledge/guides.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const root = process.cwd();
const catalogPath = argValue("--catalog") ?? path.join("content", "catalog.json");
const scenarioPath = argValue("--scenario") ?? path.join("content", "scenarios", "example.yaml");
const guidesPath = argValue("--guides") ?? path.join("content", "guides.json");

const catalog = loadCatalog(path.join(root, catalogPath));
const guides = loadGuides(path.join(root, guidesPath));
const scenario = loadScenario(path.join(root, scenarioPath));

const outcome = runDialog({ scenario, catalog, guides, event: { type: "start" } });
if (outcome.status !== "ok" || !outcome.instruction) {
  console.error("Не удалось собрать инструкцию.");
  process.exit(1);
}

const header = outcome.steps[0]?.view.text;
const chunks = formatInstruction(outcome.instruction, {
  ...(header ? { header } : {}),
  ...(outcome.disclaimer ? { disclaimer: outcome.disclaimer } : {}),
});

console.log(`Инструкция «${scenario.title}» (сценарий ${scenario.code} v${scenario.version})`);
console.log(`Документов: ${outcome.instruction.total}. Сервисов: ${outcome.instruction.sections.length}.`);
console.log(`Сообщений MAX: ${chunks.length}.\n`);

chunks.forEach((chunk, index) => {
  console.log(`──── сообщение ${index + 1}/${chunks.length} ────`);
  console.log(chunk);
  console.log("");
});
