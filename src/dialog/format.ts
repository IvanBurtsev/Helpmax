import type { Instruction, InstructionItem } from "../knowledge/instruction.js";

// Текстовая форма инструкции для MAX. Разметка — Markdown (MAX её поддерживает):
// жирные заголовки сервисов и документов, цитата для дисклеймера.
//
// Инструкция длинная, поэтому режем её на сообщения по границам документов:
// одно сообщение MAX не должно превышать лимит, и ни один документ нельзя
// разрывать между сообщениями. Оформление живёт здесь, данные — в
// knowledge/instruction.ts.

export const INSTRUCTION_CHUNK_CHARS = 3500;

// Дисклеймер — цитатой, чтобы визуально отделялся от списка.
export function formatDisclaimer(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return trimmed
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line.trim()}`))
    .join("\n");
}

function itemBlock(item: InstructionItem): string {
  const lines: string[] = [];
  const tag = item.manual ? " _(может понадобиться)_" : "";
  lines.push(`**${item.title}**${tag}`);
  lines.push(`Как получить: ${item.howTo}`);
  if (item.note !== "" && !item.howTo.includes(item.note)) {
    lines.push(`Пометка: ${item.note}`);
  }
  for (const link of item.links) {
    lines.push(`Ссылка: ${link.title} — ${link.url}`);
  }
  return lines.join("\n");
}

export interface FormatInstructionOptions {
  /** Заголовок сообщения (например, «Как получить документы»). */
  header?: string;
  /** Дисклеймер сценария — прикладывается в конце. */
  disclaimer?: string;
  /** Максимальная длина одного сообщения в символах. */
  maxChars?: number;
}

// Собирает блоки и пакует их в сообщения, не разрывая отдельный блок.
function packBlocks(blocks: readonly string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current === "") {
      current = block;
      continue;
    }
    if (current.length + 2 + block.length <= maxChars) {
      current = `${current}\n\n${block}`;
    } else {
      chunks.push(current);
      current = block;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}

export function formatInstruction(instruction: Instruction, options: FormatInstructionOptions = {}): string[] {
  const maxChars = options.maxChars ?? INSTRUCTION_CHUNK_CHARS;
  const blocks: string[] = [];

  const header = options.header?.trim();
  if (header) blocks.push(`**${header}**`);
  blocks.push(`Всего документов: ${instruction.total}. Ниже — что нужно и как получить каждый.`);

  for (const section of instruction.sections) {
    blocks.push(section.url ? `**${section.title}** — ${section.url}` : `**${section.title}**`);
    for (const item of section.items) blocks.push(itemBlock(item));
  }

  const disclaimer = options.disclaimer?.trim();
  if (disclaimer) blocks.push(formatDisclaimer(disclaimer));

  return packBlocks(blocks, maxChars);
}
