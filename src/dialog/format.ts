import { itemsByGroup, splitRequired, type Checklist, type ChecklistItem } from "../engine/checklist.js";

// Текстовая форма чек-листа для сообщения в MAX.
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
  lines.push(`Обязательно собрать (${checklist.summary.required}):`);
  for (const item of first) lines.push(bullet(item));
  if (rest.length > 0) {
    lines.push(`…и ещё ${rest.length} — пришлём после консультации.`);
  }

  const lawyer = itemsByGroup(checklist, "lawyer");
  if (lawyer.length > 0) {
    lines.push("", `Уточнит юрист (${lawyer.length}):`);
    for (const item of lawyer) lines.push(bullet(item));
  }

  return lines.join("\n");
}
