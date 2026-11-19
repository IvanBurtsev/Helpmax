import type { Update } from "@maxhub/max-bot-api/types";
import { describe, expect, it } from "vitest";
import { dedupeKey, isLate, isUpdateLike, parseUpdate } from "../src/updates.js";

// Разбор событий MAX: ключ дедупликации и диалоговое событие. Без сети.

const user = { user_id: 20, name: "Иван", first_name: "Иван", username: null, is_bot: false, last_activity_time: 0 };
const TS = 1_700_000_000;

function botStarted(): Update {
  return { update_type: "bot_started", timestamp: TS, chat_id: 10, user, payload: null } as unknown as Update;
}

function callback(payload: string | undefined, callbackId = "cb1", ts = TS): Update {
  return {
    update_type: "message_callback",
    timestamp: ts,
    callback: { timestamp: ts, callback_id: callbackId, ...(payload !== undefined ? { payload } : {}), user },
    message: {
      recipient: { chat_id: 10, chat_type: "dialog", user_id: 20, post_id: null },
      timestamp: ts,
      body: { mid: "m1", seq: 1, text: null },
    },
  } as unknown as Update;
}

function messageCreated(mid: string): Update {
  return {
    update_type: "message_created",
    timestamp: TS,
    message: {
      sender: user,
      recipient: { chat_id: 10, chat_type: "dialog", user_id: 20, post_id: null },
      timestamp: TS,
      body: { mid, seq: 1, text: "привет" },
    },
  } as unknown as Update;
}

function messageCreatedText(mid: string, text: string): Update {
  const base = messageCreated(mid) as unknown as { message: { body: { text: string } } };
  base.message.body.text = text;
  return base as unknown as Update;
}

function messageWithAudio(mid: string, url: string): Update {
  return {
    update_type: "message_created",
    timestamp: TS,
    message: {
      sender: user,
      recipient: { chat_id: 10, chat_type: "dialog", user_id: 20, post_id: null },
      timestamp: TS,
      body: { mid, seq: 1, text: null, attachments: [{ type: "audio", payload: { url, token: "t" } }] },
    },
  } as unknown as Update;
}

describe("dedupeKey", () => {
  it("стабилен для одного и того же события", () => {
    expect(dedupeKey(callback("a"))).toBe(dedupeKey(callback("a")));
  });

  it("различает два нажатия одной кнопки (разный callback_id)", () => {
    expect(dedupeKey(callback("a", "cb1"))).not.toBe(dedupeKey(callback("a", "cb2")));
  });

  it("различает разные payload и разные сообщения", () => {
    expect(dedupeKey(callback("a"))).not.toBe(dedupeKey(callback("b")));
    expect(dedupeKey(messageCreated("m1"))).not.toBe(dedupeKey(messageCreated("m2")));
  });
});

describe("isLate", () => {
  it("считает событие опоздавшим, если старше 10 минут", () => {
    const nowMs = TS * 1000;
    expect(isLate(botStarted(), nowMs)).toBe(false);
    expect(isLate(botStarted(), nowMs + 11 * 60 * 1000)).toBe(true);
  });

  it("понимает timestamp в миллисекундах", () => {
    const update = { update_type: "bot_started", timestamp: TS * 1000, chat_id: 10, user, payload: null } as unknown as Update;
    expect(isLate(update, TS * 1000 + 60_000)).toBe(false);
  });
});

describe("isUpdateLike", () => {
  it("отсекает не-события", () => {
    expect(isUpdateLike({ update_type: "bot_started" })).toBe(true);
    expect(isUpdateLike(null)).toBe(false);
    expect(isUpdateLike({})).toBe(false);
    expect(isUpdateLike("bot_started")).toBe(false);
  });
});

describe("parseUpdate", () => {
  it("bot_started → событие start", () => {
    const parsed = parseUpdate(botStarted(), TS * 1000);
    expect(parsed.event).toEqual({ type: "start" });
    expect(parsed.chatId).toBe(10);
    expect(parsed.userId).toBe(20);
    expect(parsed.updateType).toBe("bot_started");
  });

  it("message_callback с payload-ответом → событие answer", () => {
    const parsed = parseUpdate(callback(JSON.stringify({ s: "who", v: "person" })), TS * 1000);
    expect(parsed.event).toEqual({ type: "answer", stepId: "who", value: "person" });
    expect(parsed.chatId).toBe(10);
    expect(parsed.userId).toBe(20);
  });

  it("message_callback с навигацией → back/restart", () => {
    expect(parseUpdate(callback("nav:back"), TS * 1000).event).toEqual({ type: "back" });
    expect(parseUpdate(callback("nav:restart"), TS * 1000).event).toEqual({ type: "restart" });
  });

  it("message_callback без payload → без диалогового события", () => {
    expect(parseUpdate(callback(undefined), TS * 1000).event).toBeUndefined();
  });

  it("message_created → без диалогового события, но с chat/user", () => {
    const parsed = parseUpdate(messageCreated("m1"), TS * 1000);
    expect(parsed.event).toBeUndefined();
    expect(parsed.chatId).toBe(10);
    expect(parsed.userId).toBe(20);
  });

  it("свободный текст → запрос подсказки, не ответ", () => {
    const parsed = parseUpdate(messageCreated("m1"), TS * 1000);
    expect(parsed.event).toBeUndefined();
    expect(parsed.assist).toEqual({ kind: "text", text: "привет" });
  });

  it("команды /start и /restart → события диалога", () => {
    const start = parseUpdate(messageCreatedText("m1", "/start"), TS * 1000);
    expect(start.event).toEqual({ type: "start" });
    expect(start.assist).toBeUndefined();
    expect(parseUpdate(messageCreatedText("m2", "/restart"), TS * 1000).event).toEqual({ type: "restart" });
  });

  it("команда /help → подсказка по шагу", () => {
    expect(parseUpdate(messageCreatedText("m1", "/help"), TS * 1000).assist).toEqual({ kind: "step" });
  });

  it("кнопки «Не понятно» и «Как получить?» → подсказка", () => {
    expect(parseUpdate(callback("help:step"), TS * 1000).assist).toEqual({ kind: "step" });
    expect(parseUpdate(callback("help:checklist"), TS * 1000).assist).toEqual({ kind: "checklist" });
    expect(parseUpdate(callback("help:step"), TS * 1000).event).toBeUndefined();
  });

  it("голосовое сообщение → запрос распознавания", () => {
    const parsed = parseUpdate(messageWithAudio("m1", "https://cdn.max.ru/voice.ogg"), TS * 1000);
    expect(parsed.assist).toEqual({ kind: "voice", url: "https://cdn.max.ru/voice.ogg" });
  });
});
