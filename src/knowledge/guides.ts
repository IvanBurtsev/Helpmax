import fs from "node:fs";
import { z } from "zod";

// Инструкции «где получить документ» — отдельно от каталога (content/guides.json).
// Каталог отвечает на вопрос «какой документ нужен», гайд — «как его получить».
// Один документ переиспользуется в разных сценариях, ссылки проверяются
// централизованно. Черновик: пока review_status = draft, это не юридическая
// инструкция, а подсказка, которую подтверждает юрист/оператор.

const linkSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
});

const guideSchema = z.object({
  code: z.string().min(1),
  title: z.string().min(1),
  service: z.string().min(1),
  how_to: z.string().min(1),
  links: z.array(linkSchema).default([]),
  review_status: z.enum(["draft", "verified"]).default("draft"),
});

const serviceSchema = z.object({
  title: z.string().min(1),
  url: z.string().url().optional(),
});

export const guidesSchema = z.object({
  schemaVersion: z.number().int().optional(),
  generatedFrom: z.string().optional(),
  catalogVersion: z.string().optional(),
  review_status: z.enum(["draft", "verified"]).default("draft"),
  note: z.string().default(""),
  services: z.record(z.string(), serviceSchema).default({}),
  guides: z.array(guideSchema).min(1),
});

export type RawGuides = z.infer<typeof guidesSchema>;

export interface GuideLink {
  readonly title: string;
  readonly url: string;
}

export interface Guide {
  readonly code: string;
  readonly title: string;
  readonly service: string;
  readonly howTo: string;
  readonly links: readonly GuideLink[];
  readonly reviewStatus: "draft" | "verified";
}

export interface Guides {
  readonly version: string;
  readonly reviewStatus: "draft" | "verified";
  readonly note: string;
  readonly services: Readonly<Record<string, { title: string; url?: string | undefined }>>;
  readonly all: readonly Guide[];
  readonly byCode: ReadonlyMap<string, Guide>;
}

export function parseGuides(raw: unknown): Guides {
  const parsed = guidesSchema.parse(raw);
  const all: Guide[] = parsed.guides.map((guide) => ({
    code: guide.code,
    title: guide.title,
    service: guide.service,
    howTo: guide.how_to,
    links: guide.links,
    reviewStatus: guide.review_status,
  }));

  return {
    version: parsed.catalogVersion ?? parsed.generatedFrom ?? "unknown",
    reviewStatus: parsed.review_status,
    note: parsed.note,
    services: parsed.services,
    all,
    byCode: new Map(all.map((guide) => [guide.code, guide])),
  };
}

export function loadGuides(filePath: string): Guides {
  return parseGuides(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

// Хосты, на которые модели разрешено ставить ссылки: официальные сервисы из
// гайдов + сайт продукта. Всё остальное вырезается на выходе (sanitize).
// Нормализуем хост: убираем ведущий www., чтобы www.gosuslugi.ru и gosuslugi.ru
// считались одним адресом (проверка поддоменов в sanitizeLinks это учитывает).
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function allowedHosts(guides: Guides, extra: readonly string[] = []): Set<string> {
  const hosts = new Set<string>();
  const add = (url: string): void => {
    try {
      hosts.add(normalizeHost(new URL(url).hostname));
    } catch {
      // некорректный url пропускаем
    }
  };
  for (const service of Object.values(guides.services)) {
    if (service.url) add(service.url);
  }
  for (const guide of guides.all) {
    for (const link of guide.links) add(link.url);
  }
  for (const host of extra) hosts.add(normalizeHost(host));
  return hosts;
}

// Семантические проверки гайдов для CI (не бросает, возвращает список проблем).
export function validateGuides(raw: unknown, catalogCodes?: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const parsed = guidesSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`guides: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return issues;
  }

  const seen = new Set<string>();
  for (const guide of parsed.data.guides) {
    if (seen.has(guide.code)) issues.push(`guides: дубль инструкции ${guide.code}`);
    seen.add(guide.code);
    if (catalogCodes && !catalogCodes.has(guide.code)) {
      issues.push(`guides: документ ${guide.code} отсутствует в каталоге`);
    }
  }
  return issues;
}
