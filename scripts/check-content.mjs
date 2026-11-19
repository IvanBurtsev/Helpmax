#!/usr/bin/env node
// Проверка контента без сети и без БД.
// Запуск: node scripts/check-content.mjs
// Требуется пакет yaml: npm i -D yaml

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const root = process.cwd();
const catalogPath = path.join(root, "content", "catalog.json");
const scenariosDir = path.join(root, "content", "scenarios");

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readYaml(file) {
  return parse(fs.readFileSync(file, "utf8"));
}

// ---------- Каталог ----------

const catalog = readJson(catalogPath);
const conditionList = Array.isArray(catalog.conditions) ? catalog.conditions : [];
const conditions = new Set(conditionList);
const documents = Array.isArray(catalog.documents) ? catalog.documents : [];
const docsByCode = new Map(documents.map((d) => [d.id, d]));
const allowedRules = new Set(["always", "manual", ...conditions]);

if (conditions.size !== 13) {
  fail(`catalog: ожидалось 13 условий, найдено ${conditions.size}`);
}
if (documents.length !== 46) {
  warn(`catalog: ожидалось 46 документов, найдено ${documents.length}`);
}

const counts = {};
for (const doc of documents) {
  const where = `catalog: документ ${doc.id ?? "<без id>"}`;
  if (!doc.id || typeof doc.id !== "string") fail(`${where}: нет строкового id`);
  if (!doc.name || typeof doc.name !== "string") fail(`${where}: нет name`);
  if (!allowedRules.has(doc.rule)) fail(`${where}: неизвестное правило ${doc.rule}`);
  if (typeof doc.commentable !== "boolean") {
    fail(`${where}: commentable должен быть boolean`);
  }
  if (typeof doc.note !== "string") fail(`${where}: note должен быть строкой`);
  counts[doc.rule] = (counts[doc.rule] ?? 0) + 1;
}

for (const rule of allowedRules) {
  if (!counts[rule]) warn(`catalog: правило ${rule} не встречается`);
}

// ---------- Сценарии ----------

const scenarioFiles = fs.existsSync(scenariosDir)
  ? fs.readdirSync(scenariosDir).filter((f) => /\.ya?ml$/i.test(f))
  : [];

if (scenarioFiles.length === 0) {
  warn("scenarios: нет YAML-файлов");
}

const stepTypes = new Set(["choice", "multi", "confirm", "info", "checklist", "handoff"]);
const terminalTypes = new Set(["checklist", "handoff"]);

function collectVars(node, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (typeof node.var === "string") acc.push(node.var);
  for (const value of Object.values(node)) collectVars(value, acc);
  return acc;
}

for (const file of scenarioFiles) {
  const full = path.join(scenariosDir, file);
  const scenario = readYaml(full);
  const at = `scenario ${file}`;

  if (!scenario || typeof scenario !== "object") {
    fail(`${at}: пустой или невалидный YAML`);
    continue;
  }
  for (const key of ["code", "version", "title", "status", "disclaimer", "start", "steps"]) {
    if (scenario[key] === undefined || scenario[key] === "") {
      fail(`${at}: нет обязательного поля ${key}`);
    }
  }
  if (!["draft", "published", "archived"].includes(scenario.status)) {
    fail(`${at}: status должен быть draft | published | archived`);
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    fail(`${at}: steps должен быть непустым массивом`);
    continue;
  }
  if (scenario.steps.length > 40) {
    fail(`${at}: больше 40 шагов`);
  }

  const steps = new Map();
  for (const step of scenario.steps) {
    if (!step?.id) {
      fail(`${at}: шаг без id`);
      continue;
    }
    if (steps.has(step.id)) fail(`${at}: дубль шага ${step.id}`);
    steps.set(step.id, step);
  }

  if (!steps.has(scenario.start)) {
    fail(`${at}: start=${scenario.start} не существует`);
  }

  const edges = new Map();

  for (const [id, step] of steps) {
    const where = `${at}: шаг ${id}`;
    if (!stepTypes.has(step.type)) {
      fail(`${where}: неизвестный тип ${step.type}`);
    }
    if (step.type === "checklist") {
      if (!step.title && !step.text) fail(`${where}: нет title/text`);
    } else if (typeof step.text !== "string" || step.text.trim() === "") {
      fail(`${where}: пустой text`);
    }

    const nextTargets = [];
    const addNext = (target, label) => {
      if (target === undefined) return;
      if (typeof target !== "string") {
        fail(`${where}: next должен быть строкой (${label})`);
        return;
      }
      if (!steps.has(target)) {
        fail(`${where}: next=${target} не существует (${label})`);
      }
      nextTargets.push(target);
    };

    if (step.next !== undefined) addNext(step.next, "step.next");

    if (step.type === "choice" || step.type === "multi") {
      if (!Array.isArray(step.options) || step.options.length === 0) {
        fail(`${where}: options должен быть непустым массивом`);
      } else {
        const optionIds = new Set();
        let hasUnknown = false;
        let hasExclusive = false;
        for (const opt of step.options) {
          if (!opt?.id) fail(`${where}: вариант без id`);
          if (optionIds.has(opt.id)) fail(`${where}: дубль варианта ${opt.id}`);
          optionIds.add(opt.id);
          if (!opt.label) fail(`${where}: вариант ${opt.id} без label`);
          if (opt.id === "unknown" || /не знаю|другое/i.test(String(opt.label))) {
            hasUnknown = true;
          }
          if (opt.exclusive === true) hasExclusive = true;
          if (opt.next !== undefined) addNext(opt.next, `option ${opt.id}`);
        }
        if (!hasUnknown && !hasExclusive) {
          fail(`${where}: нет «Не знаю»/«Другое» или exclusive-варианта`);
        }
      }
    }

    if (step.type === "confirm") {
      // confirm — строго да/нет; options не обязательны
      if (step.options !== undefined) {
        warn(`${where}: для confirm лучше не задавать options, используйте choice`);
      }
    }

    if (step.type === "info") {
      if (step.next === undefined) fail(`${where}: info без next`);
    }

    if (step.type === "handoff") {
      if (!step.consent_text) fail(`${where}: handoff без consent_text`);
    }

    if (step.type === "checklist") {
      const hasCatalog = step.source === "catalog";
      const hasDocuments = step.documents !== undefined;
      if (hasCatalog && hasDocuments) {
        fail(`${where}: нельзя одновременно source: catalog и documents`);
      }
      if (!hasCatalog && !hasDocuments) {
        fail(`${where}: нужен source: catalog или documents`);
      }
      if (hasDocuments) {
        if (!Array.isArray(step.documents)) {
          fail(`${where}: documents должен быть массивом`);
        } else {
          for (const item of step.documents) {
            const code = typeof item === "string" ? item : item?.code;
            if (!code) {
              fail(`${where}: документ без code`);
            } else if (!docsByCode.has(code)) {
              fail(`${where}: документ ${code} отсутствует в catalog.json`);
            }
          }
        }
      }
    }

    if (!terminalTypes.has(step.type) && nextTargets.length === 0) {
      fail(`${where}: нет next и это не терминальный шаг`);
    }

    edges.set(id, nextTargets);
  }

  // Достижимость от start
  const reachable = new Set();
  const stack = [scenario.start];
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of edges.get(id) ?? []) stack.push(next);
  }
  for (const id of steps.keys()) {
    if (!reachable.has(id)) fail(`${at}: шаг ${id} недостижим из start`);
  }

  // Условия
  const declared = scenario.conditions;
  if (declared !== undefined) {
    if (typeof declared !== "object" || Array.isArray(declared)) {
      fail(`${at}: conditions должен быть объектом`);
    } else {
      for (const [key, value] of Object.entries(declared)) {
        if (!conditions.has(key)) {
          fail(`${at}: условие ${key} не из списка 13`);
        }
        if (!value || typeof value.when !== "object") {
          fail(`${at}: условие ${key} без when (JSONLogic)`);
          continue;
        }
        for (const ref of collectVars(value.when)) {
          if (ref.startsWith("answers.")) {
            const answerId = ref.slice("answers.".length);
            if (!steps.has(answerId)) {
              fail(`${at}: условие ${key} ссылается на несуществующий ответ ${ref}`);
            }
          }
        }
      }
    }
  }

  const checklist = [...steps.values()].find((s) => s.type === "checklist");
  if (checklist?.source === "catalog" && declared === undefined) {
    warn(`${at}: source: catalog без conditions — все условия будут false`);
  }

  // Циклы (Назад — это UI, а не ребро графа; цикл в графе подозрителен)
  const color = new Map();
  const visit = (id) => {
    color.set(id, "gray");
    for (const next of edges.get(id) ?? []) {
      if (color.get(next) === "gray") {
        warn(`${at}: цикл в графе через шаг ${next}`);
      } else if (!color.has(next)) {
        visit(next);
      }
    }
    color.set(id, "black");
  };
  visit(scenario.start);
}

// ---------- Итог ----------

const ruleSummary = Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}=${v}`)
  .join(", ");

console.log(`Каталог: ${documents.length} документов, ${conditions.size} условий`);
console.log(`Правила: ${ruleSummary}`);
console.log(`Сценарии: ${scenarioFiles.length}`);

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);

if (errors.length) {
  console.error(`\nПровал: ${errors.length} ошибок, ${warnings.length} предупреждений`);
  process.exit(1);
}
console.log(`\nOK: ${warnings.length} предупреждений, ошибок нет`);
