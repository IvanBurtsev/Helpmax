import fs from "node:fs";
import { z } from "zod";

// Каталог документов — снимок каталога сайта (content/catalog.json).
// Здесь он приводится к внутренней форме: id -> code, name -> title.
// Документ — источник правды, сценарий его не дублирует.

export const RULE_ALWAYS = "always";
export const RULE_MANUAL = "manual";

const documentSchema = z.object({
  id: z.string().min(1),
  source: z.string().default(""),
  name: z.string().min(1),
  note: z.string().default(""),
  rule: z.string().min(1),
  commentable: z.boolean().default(false),
});

export const catalogSchema = z.object({
  source: z.string().default(""),
  extractedAt: z.string().default(""),
  conditions: z.array(z.string().min(1)),
  ruleLabels: z.record(z.string(), z.string()).default({}),
  documents: z.array(documentSchema).min(1),
  schemaVersion: z.number().int().optional(),
  note: z.string().optional(),
});

export type RawCatalog = z.infer<typeof catalogSchema>;
export type RawDocument = z.infer<typeof documentSchema>;

export interface CatalogDocument {
  readonly code: string;
  readonly title: string;
  readonly source: string;
  readonly rule: string;
  readonly note: string;
  readonly commentable: boolean;
}

export interface Catalog {
  readonly version: string;
  readonly source: string;
  readonly conditions: readonly string[];
  readonly ruleLabels: Readonly<Record<string, string>>;
  readonly documents: readonly CatalogDocument[];
  readonly byCode: ReadonlyMap<string, CatalogDocument>;
}

export function parseCatalog(raw: unknown): Catalog {
  const parsed = catalogSchema.parse(raw);
  const documents: CatalogDocument[] = parsed.documents.map((doc) => ({
    code: doc.id,
    title: doc.name,
    source: doc.source,
    rule: doc.rule,
    note: doc.note,
    commentable: doc.commentable,
  }));

  return {
    version: parsed.extractedAt,
    source: parsed.source,
    conditions: parsed.conditions,
    ruleLabels: parsed.ruleLabels,
    documents,
    byCode: new Map(documents.map((doc) => [doc.code, doc])),
  };
}

export function loadCatalog(filePath: string): Catalog {
  const text = fs.readFileSync(filePath, "utf8");
  return parseCatalog(JSON.parse(text));
}

export function isManualDocument(doc: CatalogDocument): boolean {
  return doc.rule === RULE_MANUAL;
}

// required считается по правилу и ответам, а не хранится в сценарии жёстко.
// manual никогда не обязателен для клиента — уходит в «уточнит юрист».
export function isRequiredDocument(
  doc: CatalogDocument,
  conditions: Readonly<Record<string, boolean>>,
): boolean {
  if (doc.rule === RULE_MANUAL) return false;
  if (doc.rule === RULE_ALWAYS) return true;
  return conditions[doc.rule] === true;
}

// Семантические проверки каталога для CI (не бросает, возвращает список проблем).
export function validateCatalog(raw: unknown, expected?: { conditions?: number; documents?: number }): string[] {
  const issues: string[] = [];
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`catalog: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return issues;
  }

  const catalog = parsed.data;
  const conditionSet = new Set(catalog.conditions);
  const allowedRules = new Set<string>([RULE_ALWAYS, RULE_MANUAL, ...catalog.conditions]);

  if (expected?.conditions !== undefined && conditionSet.size !== expected.conditions) {
    issues.push(`catalog: ожидалось ${expected.conditions} условий, найдено ${conditionSet.size}`);
  }
  if (expected?.documents !== undefined && catalog.documents.length !== expected.documents) {
    issues.push(`catalog: ожидалось ${expected.documents} документов, найдено ${catalog.documents.length}`);
  }

  const seen = new Set<string>();
  for (const doc of catalog.documents) {
    if (seen.has(doc.id)) issues.push(`catalog: дубль документа ${doc.id}`);
    seen.add(doc.id);
    if (!allowedRules.has(doc.rule)) {
      issues.push(`catalog: документ ${doc.id}: неизвестное правило ${doc.rule}`);
    }
  }

  for (const condition of catalog.conditions) {
    if (!catalog.ruleLabels[condition]) {
      issues.push(`catalog: у условия ${condition} нет подписи в ruleLabels`);
    }
  }

  return issues;
}
