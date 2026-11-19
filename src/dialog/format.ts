import { itemsByGroup, splitRequired, type Checklist, type ChecklistItem } from "../engine/checklist.js";
import type { Progress } from "../engine/progress.js";

// Текстовая форма чек-листа для сообщения в MAX. Разметка — Markdown (MAX её
// поддерживает): жирные заголовки, маркеры, цитата для дисклеймера.
// Обязательные выводим прогрессивно: сначала ключевые, остальные — «после
// консультации». manual-документы идут отдельным блоком «уточнит юрист».

export const CHECKLIST_PREVIEW = 6;

function bullet(item: ChecklistItem): string {
  return `• ${item.title}`;
}

export function formatChecklist(checklist: Checklist, options: { preview?: number } = {}): string {
  const preview = options.preview ?? CHECKLIST_PREVIEW;
  const lines: string[] = [];

  const { first, rest } = splitRequired(checklist, preview);
  lines.push(`**Обязательно собрать (${checklist.summary.required}):**`);
  for (const item of first) lines.push(bullet(item));
  if (rest.length > 0) {
    lines.push(`…и ещё ${rest.length} — пришлём после консультации.`);
  }

  const lawyer = itemsByGroup(checklist, "lawyer");
  if (lawyer.length > 0) {
    lines.push("", `**Уточнит юрист (${lawyer.length}):**`);
    for (const item of lawyer) lines.push(bullet(item));
  }

  return lines.join("\n");
}

// Дисклеймер — цитатой, чтобы визуально отделялся от списка.
export function formatDisclaimer(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return trimmed
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line.trim()}`))
    .join("\n");
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Прогресс по кратчайшему оставшемуся пути: «Осталось примерно N вопросов».
export function formatProgress(progress: Progress): string {
  if (progress.total <= 0 || progress.remaining <= 0) return "";
  const filled = Math.max(0, Math.min(10, Math.round((progress.percent / 100) * 10)));
  const bar = "▰".repeat(filled) + "▱".repeat(10 - filled);
  const word = plural(progress.remaining, "вопрос", "вопроса", "вопросов");
  return `Осталось примерно ${progress.remaining} ${word}\n${bar} ${progress.percent}%`;
}
