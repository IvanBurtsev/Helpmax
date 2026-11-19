import type { InlineKeyboardAttachmentRequest, MessageTextFormat } from "@maxhub/max-bot-api/types";
import { buildKeyboard } from "../max/keyboard.js";
import type { EnqueueInput } from "../store/outbox.js";
import { formatChecklist } from "./format.js";
import type { DialogOutcome } from "./orchestrator.js";

// Превращение результата диалога в задания для outbox. Здесь нет сети и БД:
// на выходе — чистые данные, которые воркер кладёт в таблицу outbox.

export interface MessagePayload {
  chatId: number;
  text: string;
  keyboard?: InlineKeyboardAttachmentRequest;
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
}

// Один экран диалога = одно сообщение. Чек-лист дополняется текстом списка и
// дисклеймером. idempotency_key привязан к событию и шагу, поэтому повторная
// обработка того же события не создаёт дубль.
export function outcomeToScreens(outcome: DialogOutcome, ctx: ScreenContext): EnqueueInput[] {
  const screens: EnqueueInput[] = [];

  outcome.steps.forEach((step, index) => {
    const keyboard = buildKeyboard(step.view, step.nav);
    let text = step.view.text;

    if (outcome.checklist && step.view.terminal) {
      const parts = [text, formatChecklist(outcome.checklist), outcome.checklist.disclaimer].filter(
        (part) => part.trim() !== "",
      );
      text = parts.join("\n\n");
    }

    const payload: MessagePayload = {
      chatId: ctx.chatId,
      text,
      ...(keyboard ? { keyboard } : {}),
    };

    screens.push({
      chatId: ctx.chatId,
      sessionId: ctx.sessionId,
      kind: "message",
      payload,
      idempotencyKey: `${ctx.sourceKey}:${step.stepId}:${index}`,
    });
  });

  return screens;
}
