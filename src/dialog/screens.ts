import type { AttachmentRequest, InlineKeyboardAttachmentRequest, MessageTextFormat } from "@maxhub/max-bot-api/types";
import { buildKeyboard } from "../max/keyboard.js";
import type { EnqueueInput } from "../store/outbox.js";
import { formatInstruction } from "./format.js";
import type { DialogOutcome } from "./orchestrator.js";

// Превращение результата диалога в задания для outbox. Здесь нет сети и БД:
// на выходе — чистые данные, которые воркер кладёт в таблицу outbox.
// Сообщения размечены Markdown: MAX его поддерживает (жирный, списки, цитаты).
//
// Инструкция длинная, поэтому занимает несколько сообщений. Клавиатура идёт на
// последнем сообщении (после того как клиент всё прочитал), картинка-шапка — на
// первом. Ни один документ между сообщениями не разрывается: разбиение —
// в formatInstruction.

export interface MessagePayload {
  chatId: number;
  text: string;
  keyboard?: InlineKeyboardAttachmentRequest;
  /** Вложения помимо клавиатуры (например, картинка-шапка). */
  attachments?: AttachmentRequest[];
  format?: MessageTextFormat;
}

export interface EditPayload {
  messageId: string;
  text?: string;
  keyboard?: InlineKeyboardAttachmentRequest | null;
}

export interface ScreenContext {
  chatId: number;
  sessionId: string | null;
  /** Стабильный ключ источника (id события) — основа idempotency_key. */
  sourceKey: string;
  /** Публичный URL картинки-шапки; крепится к первому экрану. */
  heroUrl?: string;
}

export function outcomeToScreens(outcome: DialogOutcome, ctx: ScreenContext): EnqueueInput[] {
  const screens: EnqueueInput[] = [];

  outcome.steps.forEach((step) => {
    if (outcome.instruction) {
      const texts = formatInstruction(outcome.instruction, {
        ...(step.view.text ? { header: step.view.text } : {}),
        ...(outcome.disclaimer ? { disclaimer: outcome.disclaimer } : {}),
      });

      texts.forEach((text, index) => {
        const last = index === texts.length - 1;
        const keyboard = last ? buildKeyboard(step.view, step.nav, { help: "checklist" }) : undefined;
        const attachments: AttachmentRequest[] | undefined =
          index === 0 && ctx.heroUrl ? [{ type: "image", payload: { url: ctx.heroUrl } }] : undefined;

        const payload: MessagePayload = {
          chatId: ctx.chatId,
          text,
          format: "markdown",
          ...(keyboard ? { keyboard } : {}),
          ...(attachments ? { attachments } : {}),
        };

        screens.push({
          chatId: ctx.chatId,
          sessionId: ctx.sessionId,
          kind: "message",
          payload,
          idempotencyKey: `${ctx.sourceKey}:${step.stepId}:${index}`,
        });
      });
      return;
    }

    // Запасной путь: шаг без инструкции (например, гайды не загрузились).
    const keyboard = buildKeyboard(step.view, step.nav, { help: "step" });
    const attachments: AttachmentRequest[] | undefined = ctx.heroUrl
      ? [{ type: "image", payload: { url: ctx.heroUrl } }]
      : undefined;
    const payload: MessagePayload = {
      chatId: ctx.chatId,
      text: step.view.text,
      format: "markdown",
      ...(keyboard ? { keyboard } : {}),
      ...(attachments ? { attachments } : {}),
    };
    screens.push({
      chatId: ctx.chatId,
      sessionId: ctx.sessionId,
      kind: "message",
      payload,
      idempotencyKey: `${ctx.sourceKey}:${step.stepId}:0`,
    });
  });

  return screens;
}
