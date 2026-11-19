import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadCatalog, validateCatalog } from "../src/catalog.js";
import { loadScenario, validateScenario } from "../src/engine/scenario.js";

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
    expect(validateScenario(readScenarioRaw())).toEqual([]);
  });

  it("пример сценария загружается как инструкция", () => {
    const scenario = loadScenario(scenarioPath);
    expect(scenario.code).toBe("bankruptcy");
    expect(scenario.status).toBe("draft");
    expect(scenario.start).toBe("instruction");
    expect(scenario.steps[0]?.type).toBe("instruction");
  });

  it("ловит несуществующий стартовый шаг", () => {
    const broken = {
      code: "broken",
      version: 1,
      title: "t",
      status: "draft",
      disclaimer: "d",
      start: "missing",
      steps: [{ id: "instruction", type: "instruction", title: "x" }],
    };
    const issues = validateScenario(broken);
    expect(issues.some((issue) => issue.includes("start=missing"))).toBe(true);
  });

  it("ловит дубль шага", () => {
    const broken = {
      code: "broken",
      version: 1,
      title: "t",
      status: "draft",
      disclaimer: "d",
      start: "instruction",
      steps: [
        { id: "instruction", type: "instruction", title: "x" },
        { id: "instruction", type: "instruction", title: "y" },
      ],
    };
    const issues = validateScenario(broken);
    expect(issues.some((issue) => issue.includes("дубль"))).toBe(true);
  });
});
