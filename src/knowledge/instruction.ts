import { isManualDocument, type Catalog, type CatalogDocument } from "../catalog.js";
import type { GuideLink, Guides } from "./guides.js";

// Инструкция «как получить документы» собирается из двух источников правды:
// каталога (какие документы нужны) и гайдов (как и где получить каждый).
// Группируем по сервису — клиенту так понятнее, куда идти. Опросника больше нет,
// поэтому показываем весь список; редкие документы (rule: manual) помечаем
// «может понадобиться», чтобы их не приняли за обязательные.
//
// Гайды необязательны: без них список всё равно строится из каталога, а вместо
// шагов получения показываем пометку из каталога или честное «уточнит юрист».

export interface InstructionItem {
  readonly code: string;
  readonly title: string;
  readonly note: string;
  readonly howTo: string;
  readonly links: readonly GuideLink[];
  /** Редкий документ: показываем с пометкой «может понадобиться». */
  readonly manual: boolean;
}

export interface InstructionSection {
  readonly service: string;
  readonly title: string;
  readonly url?: string;
  readonly items: readonly InstructionItem[];
}

export interface Instruction {
  readonly sections: readonly InstructionSection[];
  readonly total: number;
}

const FALLBACK_SERVICE = "Прочие документы";
const NO_GUIDE = "Как получить — уточнит юрист.";

function toItem(doc: CatalogDocument, guides: Guides | undefined): InstructionItem {
  const guide = guides?.byCode.get(doc.code);
  const note = doc.note.trim();
  return {
    code: doc.code,
    title: doc.title,
    note,
    howTo: guide?.howTo ?? (note || NO_GUIDE),
    links: guide?.links ?? [],
    manual: isManualDocument(doc),
  };
}

interface MutableSection {
  service: string;
  title: string;
  url?: string;
  items: InstructionItem[];
}

// Порядок сервисов — по первому появлению документа в каталоге: так список
// предсказуем и совпадает с порядком на сайте.
export function buildInstruction(catalog: Catalog, guides?: Guides): Instruction {
  const order: string[] = [];
  const byService = new Map<string, MutableSection>();

  for (const doc of catalog.documents) {
    const guide = guides?.byCode.get(doc.code);
    const service = guide?.service ?? (doc.source.trim() || FALLBACK_SERVICE);

    let section = byService.get(service);
    if (!section) {
      const meta = guides?.services[service];
      section = {
        service,
        title: meta?.title ?? service,
        ...(meta?.url ? { url: meta.url } : {}),
        items: [],
      };
      byService.set(service, section);
      order.push(service);
    }
    section.items.push(toItem(doc, guides));
  }

  const sections: InstructionSection[] = [];
  for (const service of order) {
    const section = byService.get(service);
    if (!section) continue;
    sections.push({
      service: section.service,
      title: section.title,
      ...(section.url ? { url: section.url } : {}),
      items: section.items,
    });
  }

  return { sections, total: catalog.documents.length };
}
