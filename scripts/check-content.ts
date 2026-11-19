#!/usr/bin/env node
// Проверка контента без сети и без БД. Использует те же схемы, что и движок,
// поэтому в CI и в рантайме действуют одни и те же правила.
// Запуск: npm run check:content

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { validateCatalog, loadCatalog, type Catalog } from "../src/catalog.js";
import { validateScenario } from "../src/engine/scenario.js";
import { validateGuides } from "../src/knowledge/guides.js";

const root = process.cwd();
const catalogPath = path.join(root, "content", "catalog.json");
const scenariosDir = path.join(root, "content", "scenarios");

const EXPECTED_CONDITIONS = 13;
const EXPECTED_DOCUMENTS = 46;

const errors: string[] = [];
const warnings: string[] = [];

function readYaml(file: string): unknown {
  return parse(fs.readFileSync(file, "utf8"));
}

// ---------- Каталог ----------

const rawCatalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Record<string, unknown>;
errors.push(...validateCatalog(rawCatalog, { conditions: EXPECTED_CONDITIONS, documents: EXPECTED_DOCUMENTS }));

let catalog: Catalog | undefined;
try {
  catalog = loadCatalog(catalogPath);
} catch (error) {
  errors.push(`catalog: не удалось разобрать (${error instanceof Error ? error.message : String(error)})`);
}

const documents = Array.isArray(rawCatalog["documents"]) ? rawCatalog["documents"] : [];
const counts: Record<string, number> = {};
for (const doc of documents as Array<Record<string, unknown>>) {
  const rule = typeof doc["rule"] === "string" ? doc["rule"] : "<нет правила>";
  counts[rule] = (counts[rule] ?? 0) + 1;
}

// ---------- Гайды ----------

const guidesPath = path.join(root, "content", "guides.json");
let guidesCount = 0;
if (fs.existsSync(guidesPath)) {
  try {
    const rawGuides = JSON.parse(fs.readFileSync(guidesPath, "utf8")) as Record<string, unknown>;
    const codes = catalog ? new Set(catalog.byCode.keys()) : undefined;
    errors.push(...validateGuides(rawGuides, codes));
    guidesCount = Array.isArray(rawGuides["guides"]) ? (rawGuides["guides"] as unknown[]).length : 0;
  } catch (error) {
    errors.push(`guides: не удалось разобрать (${error instanceof Error ? error.message : String(error)})`);
  }
} else {
  warnings.push("guides: нет content/guides.json (запустите npm run build:guides)");
}

// ---------- Сценарии ----------

const scenarioFiles = fs.existsSync(scenariosDir)
  ? fs.readdirSync(scenariosDir).filter((file) => /\.ya?ml$/i.test(file))
  : [];

if (scenarioFiles.length === 0) warnings.push("scenarios: нет YAML-файлов");

for (const file of scenarioFiles) {
  const full = path.join(scenariosDir, file);
  let raw: unknown;
  try {
    raw = readYaml(full);
  } catch (error) {
    errors.push(`scenario ${file}: не удалось разобрать YAML (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  for (const issue of validateScenario(raw)) {
    errors.push(`scenario ${file}: ${issue}`);
  }
}

// ---------- Итог ----------

const conditionsCount = Array.isArray(rawCatalog["conditions"]) ? (rawCatalog["conditions"] as unknown[]).length : 0;
const ruleSummary = Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .map(([key, value]) => `${key}=${value}`)
  .join(", ");

console.log(`Каталог: ${documents.length} документов, ${conditionsCount} условий`);
console.log(`Правила: ${ruleSummary}`);
console.log(`Сценарии: ${scenarioFiles.length}`);
console.log(`Гайды: ${guidesCount} инструкций`);

for (const warning of warnings) console.warn(`WARN  ${warning}`);
for (const error of errors) console.error(`ERROR ${error}`);

if (errors.length > 0) {
  console.error(`\nПровал: ${errors.length} ошибок, ${warnings.length} предупреждений`);
  process.exit(1);
}
console.log(`\nOK: ${warnings.length} предупреждений, ошибок нет`);
