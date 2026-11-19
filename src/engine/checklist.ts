import type { Catalog, CatalogDocument } from "../catalog.js";
import { isManualDocument, isRequiredDocument } from "../catalog.js";
import type { Conditions } from "./conditions.js";
import type { Scenario } from "./scenario.js";

export type ChecklistGroup = "required" | "lawyer" | "notNeeded";

export interface ChecklistItem {
  code: string;
  title: string;
  source: string;
  note: string;
  required: boolean;
  group: ChecklistGroup;
}

export interface Checklist {
  scenarioCode: string;
  scenarioVersion: number;
  catalogVersion: string;
  disclaimer: string;
  items: ChecklistItem[];
  summary: Record<ChecklistGroup, number>;
}

function classify(doc: CatalogDocument, conditions: Conditions): ChecklistGroup {
  if (isManualDocument(doc)) return "lawyer";
  return isRequiredDocument(doc, conditions) ? "required" : "notNeeded";
}

function toItem(doc: CatalogDocument, group: ChecklistGroup): ChecklistItem {
  return {
    code: doc.code,
    title: doc.title,
    source: doc.source,
    note: doc.note,
    required: group === "required",
    group,
  };
}

// Чек-лист собирается из каталога по условиям. Явный список документов —
// только для сценария, которого нет в каталоге.
export function buildChecklist(catalog: Catalog, scenario: Scenario, conditions: Conditions): Checklist {
  const checklistStep = scenario.steps.find((step) => step.type === "checklist");

  let items: ChecklistItem[];
  if (checklistStep?.type === "checklist" && checklistStep.documents) {
    items = [];
    for (const entry of checklistStep.documents) {
      const code = typeof entry === "string" ? entry : entry.code;
      const doc = catalog.byCode.get(code);
      if (!doc) continue;
      items.push(toItem(doc, classify(doc, conditions)));
    }
  } else {
    items = catalog.documents.map((doc) => toItem(doc, classify(doc, conditions)));
  }

  const summary: Record<ChecklistGroup, number> = { required: 0, lawyer: 0, notNeeded: 0 };
  for (const item of items) summary[item.group] += 1;

  return {
    scenarioCode: scenario.code,
    scenarioVersion: scenario.version,
    catalogVersion: catalog.version,
    disclaimer: scenario.disclaimer,
    items,
    summary,
  };
}

export function itemsByGroup(checklist: Checklist, group: ChecklistGroup): ChecklistItem[] {
  return checklist.items.filter((item) => item.group === group);
}

// Прогрессивное раскрытие: 13 обязательных документов сразу — перебор.
// Показываем первые `limit`, остальные — под «Показать ещё» (они всё ещё
// обязательны). Это UI-разбиение, а не изменение состава.
export function splitRequired(
  checklist: Checklist,
  limit = 6,
): { first: ChecklistItem[]; rest: ChecklistItem[] } {
  const required = itemsByGroup(checklist, "required");
  return { first: required.slice(0, limit), rest: required.slice(limit) };
}
