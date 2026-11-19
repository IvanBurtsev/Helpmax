import { createHash } from "node:crypto";
import type { Update } from "@maxhub/max-bot-api/types";
import type { DialogEvent } from "./dialog/orchestrator.js";
import { decodeCallbackPayload } from "./max/keyboard.js";

// Разбор входящих событий MAX: стабильный ключ дедупликации и диалоговое
// событие. Чистые функции — тестируются без сети.

const LATE_THRESHOLD_MS = 10 * 60 * 1000;

export interface ParsedUpdate {
  dedupeKey: string;
  updateType: string;
  chatId: number | null;
  userId: number | null;
  late: boolean;
  /** undefined — событие не про диалог (служебное или свободный текст). */
  event?: DialogEvent;
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

function callbackEvent(payload: string | undefined): DialogEvent | undefined {
  if (!payload) return undefined;
  const decoded = decodeCallbackPayload(payload);
  if (!decoded) return undefined;
  if (decoded.kind === "nav") return { type: decoded.action };
  return { type: "answer", stepId: decoded.stepId, value: decoded.value };
}

export function parseUpdate(update: Update, nowMs: number = Date.now()): ParsedUpdate {
  const base = { dedupeKey: dedupeKey(update), updateType: update.update_type, late: isLate(update, nowMs) };
  switch (update.update_type) {
    case "bot_started":
      return { ...base, chatId: update.chat_id, userId: update.user.user_id, event: { type: "start" } };

    case "message_callback": {
      const event = callbackEvent(update.callback.payload);
      const chatId = update.message?.recipient.chat_id ?? null;
      return {
        ...base,
        chatId,
        userId: update.callback.user.user_id,
        ...(event ? { event } : {}),
      };
    }

    case "message_created":
      return {
        ...base,
        chatId: update.message.recipient.chat_id ?? null,
        userId: update.message.sender?.user_id ?? null,
      };

    default:
      return { ...base, chatId: "chat_id" in update ? update.chat_id : null, userId: null };
  }
}
