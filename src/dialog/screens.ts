import type { AttachmentRequest, InlineKeyboardAttachmentRequest, MessageTextFormat } from "@maxhub/max-bot-api/types";
import { buildKeyboard } from "../max/keyboard.js";
import type { EnqueueInput } from "../store/outbox.js";
import { formatChecklist, formatDisclaimer } from "./format.js";
import type { DialogOutcome } from "./orchestrator.js";

// Превращение результата диалога в задания для outbox. Здесь нет сети и БД:
// на выходе — чистые данные, которые воркер кладёт в таблицу outbox.
// Сообщения размечены Markdown: MAX его поддерживает (жирный, списки, цитаты).

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
  /** Строка прогресса для шагов-вопросов (не для чек-листа). */
  progressText?: string;
  /** Публичный URL картинки-шапки; крепится к первому экрану. */
  heroUrl?: string;
}

// Один экран диалога = одно сообщение. Чек-лист дополняется текстом списка и
// дисклеймером. idempotency_key привязан к событию и шагу, поэтому повторная
// обработка того же события не создаёт дубль. На каждом экране есть кнопка
// подсказки («Не понятно» / «Как получить?»).
export function outcomeToScreens(outcome: DialogOutcome, ctx: ScreenContext): EnqueueInput[] {
  const screens: EnqueueInput[] = [];

  outcome.steps.forEach((step, index) => {
    const keyboard = buildKeyboard(step.view, step.nav, { help: step.view.terminal ? "checklist" : "step" });
    let text = step.view.text;

    if (!step.view.terminal && ctx.progressText) {
      text = `${text}\n\n${ctx.progressText}`;
    }

    if (outcome.checklist && step.view.terminal) {
      const parts = [text, formatChecklist(outcome.checklist), formatDisclaimer(outcome.checklist.disclaimer)].filter(
        (part) => part.trim() !== "",
      );
      text = parts.join("\n\n");
    }

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

  return screens;
}
