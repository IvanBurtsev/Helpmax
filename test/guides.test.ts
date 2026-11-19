import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import { allowedHosts, loadGuides, validateGuides } from "../src/knowledge/guides.js";

const root = process.cwd();
const catalogPath = path.join(root, "content", "catalog.json");
const guidesPath = path.join(root, "content", "guides.json");

describe("гайды «где получить»", () => {
  it("проходят проверку и покрывают все документы каталога", () => {
    const catalog = loadCatalog(catalogPath);
    const raw = JSON.parse(fs.readFileSync(guidesPath, "utf8"));
    expect(validateGuides(raw, new Set(catalog.byCode.keys()))).toEqual([]);

    const guides = loadGuides(guidesPath);
    for (const doc of catalog.documents) {
      expect(guides.byCode.has(doc.code)).toBe(true);
    }
    expect(guides.all).toHaveLength(catalog.documents.length);
  });

  it("каждый гайд содержит инструкцию и помечен как черновик", () => {
    const guides = loadGuides(guidesPath);
    for (const guide of guides.all) {
      expect(guide.howTo.length).toBeGreaterThan(10);
      expect(guide.reviewStatus).toBe("draft");
    }
  });

  it("allowlist ссылок включает официальные сервисы и сайт", () => {
    const guides = loadGuides(guidesPath);
    const hosts = allowedHosts(guides, ["femida-ai.ru"]);
    expect(hosts.has("gosuslugi.ru")).toBe(true);
    expect(hosts.has("lknpd.nalog.ru")).toBe(true);
    expect(hosts.has("femida-ai.ru")).toBe(true);
    expect(hosts.has("evil.example.com")).toBe(false);
  });

  it("ловит инструкцию к несуществующему документу", () => {
    const raw = {
      schemaVersion: 1,
      guides: [{ code: "nope", title: "x", service: "s", how_to: "y", review_status: "draft" }],
    };
    const issues = validateGuides(raw, new Set(["other-passport"]));
    expect(issues.some((issue) => issue.includes("nope"))).toBe(true);
  });
});
