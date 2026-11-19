import { createHash } from "node:crypto";
import type { Update } from "@maxhub/max-bot-api/types";
import type { DialogEvent } from "./dialog/orchestrator.js";
import { decodeCallbackPayload } from "./max/keyboard.js";

// Разбор входящих событий MAX: стабильный ключ дедупликации и диалоговое
// событие. Чистые функции — тестируются без сети.

const LATE_THRESHOLD_MS = 10 * 60 * 1000;

/** Запрос к помощнику (LLM/STT): не меняет состояние диалога. */
export type AssistRequest =
  | { kind: "text"; text: string }
  | { kind: "voice"; url: string }
  | { kind: "step" }
  | { kind: "checklist" };

export interface ParsedUpdate {
  dedupeKey: string;
  updateType: string;
  chatId: number | null;
  userId: number | null;
  late: boolean;
  /** undefined — событие не про диалог (служебное, свободный текст, голос). */
  event?: DialogEvent;
  /** Запрос подсказки (свободный текст, голос или кнопка «Не понятно»). */
  assist?: AssistRequest;
}

// У MAX нет update_id, поэтому ключ собираем из стабильных полей события.
// Для callback нельзя брать только mid: два нажатия одной кнопки схлопнутся.
export function dedupeKey(update: Update): string {
  const parts: string[] = [update.update_type];

  switch (update.update_type) {
    case "message_callback":
      parts.push(
        String(update.message?.recipient.chat_id ?? ""),
        update.callback.callback_id,
        String(update.callback.timestamp),
        String(update.callback.user.user_id),
        update.callback.payload ?? "",
      );
      break;
    case "message_created":
      parts.push(String(update.message.recipient.chat_id ?? ""), update.message.body.mid);
      break;
    case "message_edited":
      parts.push(update.message.body.mid, String(update.message.timestamp));
      break;
    default:
      parts.push("chat_id" in update ? String(update.chat_id) : "", String(update.timestamp));
  }

  return createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

// MAX отдаёт timestamp в секундах; на всякий случай принимаем и миллисекунды.
export function isLate(update: Update, nowMs: number): boolean {
  const raw = update.timestamp;
  const ms = raw > 1e12 ? raw : raw * 1000;
  return nowMs - ms > LATE_THRESHOLD_MS;
}

// Тело вебхука приходит как unknown: сначала убеждаемся, что это событие MAX.
export function isUpdateLike(value: unknown): value is Update {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { update_type?: unknown }).update_type === "string"
  );
}

function callbackEvent(payload: string | undefined): { event?: DialogEvent; assist?: AssistRequest } {
  if (!payload) return {};
  const decoded = decodeCallbackPayload(payload);
  if (!decoded) return {};
  if (decoded.kind === "nav") return { event: { type: decoded.action } };
  if (decoded.kind === "help") return { assist: { kind: decoded.target } };
  return { event: { type: "answer", stepId: decoded.stepId, value: decoded.value } };
}

// Голосовое сообщение: берём первое аудио-вложение.
function audioUrl(body: { attachments?: unknown } | undefined): string | undefined {
  const attachments = body?.attachments;
  if (!Array.isArray(attachments)) return undefined;
  for (const attachment of attachments) {
    if (
      typeof attachment === "object" &&
      attachment !== null &&
      (attachment as { type?: unknown }).type === "audio"
    ) {
      const url = (attachment as { payload?: { url?: unknown } }).payload?.url;
      if (typeof url === "string" && url !== "") return url;
    }
  }
  return undefined;
}

// Свободный текст: команды — это события диалога, остальное — вопрос помощнику.
function messageAssist(text: string | null | undefined, body: { attachments?: unknown } | undefined): { event?: DialogEvent; assist?: AssistRequest } {
  const url = audioUrl(body);
  if (url) return { assist: { kind: "voice", url } };

  const value = text?.trim() ?? "";
  if (value === "") return {};
  const command = value.toLowerCase().split(/\s+/)[0];
  if (command === "/start") return { event: { type: "start" } };
  if (command === "/restart") return { event: { type: "restart" } };
  if (command === "/help") return { assist: { kind: "step" } };
  return { assist: { kind: "text", text: value } };
}

export function parseUpdate(update: Update, nowMs: number = Date.now()): ParsedUpdate {
  const base = { dedupeKey: dedupeKey(update), updateType: update.update_type, late: isLate(update, nowMs) };
  switch (update.update_type) {
    case "bot_started":
      return { ...base, chatId: update.chat_id, userId: update.user.user_id, event: { type: "start" } };

    case "message_callback": {
      const { event, assist } = callbackEvent(update.callback.payload);
      const chatId = update.message?.recipient.chat_id ?? null;
      return {
        ...base,
        chatId,
        userId: update.callback.user.user_id,
        ...(event ? { event } : {}),
        ...(assist ? { assist } : {}),
      };
    }

    case "message_created": {
      const { event, assist } = messageAssist(update.message.body.text, update.message.body);
      return {
        ...base,
        chatId: update.message.recipient.chat_id ?? null,
        userId: update.message.sender?.user_id ?? null,
        ...(event ? { event } : {}),
        ...(assist ? { assist } : {}),
      };
    }

    default:
      return { ...base, chatId: "chat_id" in update ? update.chat_id : null, userId: null };
  }
}
