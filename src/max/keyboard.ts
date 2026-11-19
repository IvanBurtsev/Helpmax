import { Keyboard } from "@maxhub/max-bot-api";
import type { CallbackButton, InlineKeyboardAttachmentRequest } from "@maxhub/max-bot-api/types";
import type { StepView } from "../engine/render.js";

// Маппинг представления шага (движок) в inline-клавиатуру MAX.
// Сети здесь нет: результат — чистые данные, которые легко проверить тестами.

export const NAV_BACK = "nav:back";
export const NAV_RESTART = "nav:restart";

export interface CallbackPayload {
  stepId: string;
  value: string | string[];
}

export type PayloadEncoder = (payload: CallbackPayload) => string;

// Короткий payload: JSON переживает любые id вариантов и не ломается на «:».
// value может быть строкой (choice/confirm) или массивом (multi).
export const encodeAnswerPayload: PayloadEncoder = (payload) =>
  JSON.stringify({ s: payload.stepId, v: payload.value });

export type DecodedCallback =
  | { kind: "answer"; stepId: string; value: string | string[] }
  | { kind: "nav"; action: "back" | "restart" };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function decodeCallbackPayload(raw: string): DecodedCallback | undefined {
  if (raw === NAV_BACK) return { kind: "nav", action: "back" };
  if (raw === NAV_RESTART) return { kind: "nav", action: "restart" };
  try {
    const parsed = JSON.parse(raw) as { s?: unknown; v?: unknown };
    if (typeof parsed.s === "string" && (typeof parsed.v === "string" || isStringArray(parsed.v))) {
      return { kind: "answer", stepId: parsed.s, value: parsed.v };
    }
  } catch {
    // не JSON — значит, не наш payload
  }
  return undefined;
}

export interface NavKeyboardOptions {
  back?: boolean;
  restart?: boolean;
}

export interface BuildKeyboardOptions {
  /** Кнопок в ряду. По умолчанию 2 для коротких подписей, иначе 1. */
  perRow?: number;
  encode?: PayloadEncoder;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function navButtons(options: NavKeyboardOptions): CallbackButton[] {
  const buttons: CallbackButton[] = [];
  if (options.back) buttons.push(Keyboard.button.callback("← Назад", NAV_BACK));
  if (options.restart) buttons.push(Keyboard.button.callback("Начать заново", NAV_RESTART));
  return buttons;
}

// Варианты шага и служебные кнопки — в одной клавиатуре.
// Возвращает undefined, если кнопок нет вовсе.
export function buildKeyboard(
  view: StepView,
  nav: NavKeyboardOptions = {},
  options: BuildKeyboardOptions = {},
): InlineKeyboardAttachmentRequest | undefined {
  const encode = options.encode ?? encodeAnswerPayload;
  const rows: CallbackButton[][] = [];

  if (view.options.length > 0) {
    const short = view.options.every((option) => option.label.length <= 12);
    const perRow = Math.max(1, options.perRow ?? (short ? 2 : 1));
    const buttons = view.options.map((option) =>
      Keyboard.button.callback(option.label, encode({ stepId: view.stepId, value: option.id })),
    );
    rows.push(...chunk(buttons, perRow));
  }

  const navRow = navButtons(nav);
  if (navRow.length > 0) rows.push(navRow);

  if (rows.length === 0) return undefined;
  return Keyboard.inlineKeyboard(rows);
}
