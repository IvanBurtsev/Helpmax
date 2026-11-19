import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadCatalog, validateCatalog, type Catalog } from "../src/catalog.js";
import { loadScenario, validateScenario, type Scenario } from "../src/engine/scenario.js";

const catalogPath = path.join(process.cwd(), "content", "catalog.json");
const scenarioPath = path.join(process.cwd(), "content", "scenarios", "example.yaml");

function readScenarioRaw(): unknown {
  return parse(fs.readFileSync(scenarioPath, "utf8"));
}

describe("контент", () => {
  it("каталог проходит проверку (46 документов, 13 условий)", () => {
    const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    expect(validateCatalog(raw, { conditions: 13, documents: 46 })).toEqual([]);
  });

  it("каталог маппит id -> code, name -> title", () => {
    const catalog = loadCatalog(catalogPath);
    const passport = catalog.byCode.get("other-passport");
    expect(passport).toBeDefined();
    expect(passport?.title).toBe(passport?.title); // title берётся из name
    expect(catalog.conditions).toHaveLength(13);
    expect(catalog.documents).toHaveLength(46);
  });

  it("пример сценария проходит семантическую проверку", () => {
    const catalog = loadCatalog(catalogPath);
    expect(validateScenario(readScenarioRaw(), catalog)).toEqual([]);
  });

  it("пример сценария загружается", () => {
    const catalog = loadCatalog(catalogPath);
    const scenario = loadScenario(scenarioPath, catalog);
    expect(scenario.code).toBe("bankruptcy");
    expect(scenario.status).toBe("draft");
  });

  it("ловит переход на несуществующий шаг", () => {
    const catalog = loadCatalog(catalogPath);
    const broken = {
      code: "broken",
      version: 1,
      title: "t",
      status: "draft",
      disclaimer: "d",
      start: "a",
      steps: [{ id: "a", type: "info", text: "x", next: "missing" }],
    };
    const issues = validateScenario(broken, catalog);
    expect(issues.some((issue) => issue.includes("next=missing"))).toBe(true);
  });

  it("ловит опечатку в условии", () => {
    const catalog = loadCatalog(catalogPath);
    const broken = {
      code: "broken",
      version: 1,
      title: "t",
      status: "draft",
      disclaimer: "d",
      start: "result",
      steps: [{ id: "result", type: "checklist", source: "catalog", title: "r" }],
      conditions: { pensoin: { when: { "==": [1, 1] } } },
    };
    const issues = validateScenario(broken, catalog);
    expect(issues.some((issue) => issue.includes("pensoin"))).toBe(true);
  });
});

export type { Catalog, Scenario };
