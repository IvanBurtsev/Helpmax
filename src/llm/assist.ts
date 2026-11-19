import type { Catalog, CatalogDocument } from "../catalog.js";
import type { Scenario } from "../engine/scenario.js";
import { allowedHosts, type Guides } from "../knowledge/guides.js";
import type { LlmClient } from "./client.js";
import { buildHelpMessages, type HelpDocument } from "./prompt.js";
import { clampAnswer, sanitizeLinks } from "./sanitize.js";

// Подсказка по документу: заземляем вопрос на каталог и гайды, зовём LLM,
// проверяем ссылки и длину. Всё внешнее (LLM, лог) передаётся снаружи, поэтому
// логику можно проверить подменной моделью — без сети. Если LLM нет или он
// упал — отдаём полезный откат из гайдов, диалог не ломается.

export interface AssistDeps {
  catalog: Catalog;
  guides: Guides;
  scenario: Scenario;
  llm?: LlmClient;
  maxQuestionChars?: number;
  maxAnswerChars?: number;
  /** Дополнительно разрешённые хосты для ссылок (например, сайт продукта). */
  extraAllowedHosts?: readonly string[];
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface AssistRequest {
  question: string;
  stepText?: string;
  /** Если задано — подсказка только по этим документам (например, из чек-листа). */
  documentCodes?: readonly string[];
}

export interface AssistAnswer {
  text: string;
  source: "llm" | "fallback";
}

const DEFAULT_MAX_QUESTION = 1000;
const DEFAULT_MAX_ANSWER = 1500;
const MAX_PROMPT_DOCUMENTS = 40;

function selectDocuments(deps: AssistDeps, codes?: readonly string[]): CatalogDocument[] {
  if (codes && codes.length > 0) {
    const docs: CatalogDocument[] = [];
    for (const code of codes) {
      const doc = deps.catalog.byCode.get(code);
      if (doc) docs.push(doc);
    }
    return docs;
  }
  return deps.catalog.documents.slice(0, MAX_PROMPT_DOCUMENTS);
}

function toHelpDocument(deps: AssistDeps, doc: CatalogDocument): HelpDocument {
  const guide = deps.guides.byCode.get(doc.code);
  const howTo = guide?.howTo ?? (doc.note.trim() || "Инструкция готовится — уточнит юрист.");
  return {
    code: doc.code,
    title: doc.title,
    source: doc.source,
    howTo,
    links: guide?.links ?? [],
  };
}

// Откат без LLM: те же гайды, что и в промпте, но собранные локально.
export function fallbackAnswer(deps: AssistDeps, request: AssistRequest): string {
  const docs = selectDocuments(deps, request.documentCodes);
  const lines = ["Не могу сейчас ответить через ИИ, но вот что можно сделать:"];
  if (docs.length > 0) {
    for (const doc of docs.slice(0, 5)) {
      const guide = deps.guides.byCode.get(doc.code);
      const howTo = guide?.howTo ?? (doc.note.trim() || "уточнит юрист.");
      lines.push(`• ${doc.title} — ${howTo}`);
    }
  } else {
    lines.push("• Напишите название документа или вопрос — подскажу, где его взять.");
  }
  lines.push("", "Если останутся вопросы — их уточнит юрист.");
  return lines.join("\n");
}

export async function answerHelp(deps: AssistDeps, request: AssistRequest): Promise<AssistAnswer> {
  const question = request.question.trim().slice(0, deps.maxQuestionChars ?? DEFAULT_MAX_QUESTION);
  if (!deps.llm || question === "") {
    return { text: fallbackAnswer(deps, request), source: "fallback" };
  }

  const documents = selectDocuments(deps, request.documentCodes).map((doc) => toHelpDocument(deps, doc));
  const services = Object.values(deps.guides.services);

  try {
    const messages = buildHelpMessages({
      question,
      scenarioTitle: deps.scenario.title,
      ...(request.stepText ? { stepText: request.stepText } : {}),
      documents,
      services,
      guideNote: deps.guides.note,
    });
    const raw = await deps.llm.complete(messages, { temperature: 0.2 });
    if (!raw.trim()) return { text: fallbackAnswer(deps, request), source: "fallback" };

    const allowed = allowedHosts(deps.guides, [...(deps.extraAllowedHosts ?? []), "femida-ai.ru", "max.ru"]);
    const { text, removed } = sanitizeLinks(raw, allowed);
    const clean = clampAnswer(text, deps.maxAnswerChars ?? DEFAULT_MAX_ANSWER);
    if (!clean.trim()) return { text: fallbackAnswer(deps, request), source: "fallback" };
    if (removed > 0) deps.log?.("llm_links_removed", { removed });
    return { text: clean, source: "llm" };
  } catch (error) {
    deps.log?.("llm_failed", { message: error instanceof Error ? error.message : String(error) });
    return { text: fallbackAnswer(deps, request), source: "fallback" };
  }
}
