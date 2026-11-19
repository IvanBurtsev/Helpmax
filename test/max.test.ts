import { describe, expect, it } from "vitest";
import type { StepView } from "../src/engine/render.js";
import { MaxActionError, MaxClient } from "../src/max/client.js";
import { createMaxFetch, parseRetryAfter } from "../src/max/fetch.js";
import { buildKeyboard, decodeCallbackPayload, encodeAnswerPayload, NAV_BACK, NAV_RESTART } from "../src/max/keyboard.js";
import { TokenBucket } from "../src/max/rate-limit.js";

type FetchLike = typeof globalThis.fetch;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Подменный fetch: считает вызовы и отдаёт ответ по номеру вызова.
function makeFetch(
  handler: (call: number, url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetch: FetchLike; calls: () => number } {
  let count = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    count += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(count, url, init);
  }) as unknown as FetchLike;
  return { fetch, calls: () => count };
}

describe("TokenBucket", () => {
  it("выдаёт capacity токенов сразу и ждёт пополнения", async () => {
    let now = 0;
    const slept: number[] = [];
    const bucket = new TokenBucket({
      capacity: 2,
      refillPerSecond: 10,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });

    await bucket.acquire();
    await bucket.acquire();
    expect(bucket.available).toBe(0);

    await bucket.acquire();
    expect(slept).toEqual([100]);
  });

  it("обслуживает параллельные запросы по очереди", async () => {
    let now = 0;
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerSecond: 1,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire()]);
    // первый сразу, второй через 1000 мс, третий ещё через 1000 мс
    expect(now).toBe(2000);
  });

  it("запрещает некорректные параметры", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow();
  });
});

describe("createMaxFetch", () => {
  const limiter = (): TokenBucket => new TokenBucket({ capacity: 100, refillPerSecond: 100 });

  it("повторяет 503 и возвращает успех", async () => {
    const responses = [jsonResponse({}, 503), jsonResponse({ ok: true }, 200)];
    const { fetch, calls } = makeFetch((call) => responses[call - 1] ?? jsonResponse({}, 200));
    const slept: number[] = [];
    const wrapped = createMaxFetch({
      limiter: limiter(),
      baseFetch: fetch,
      retries: 2,
      baseDelayMs: 100,
      random: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const response = await wrapped("https://api/messages");
    expect(response.status).toBe(200);
    expect(calls()).toBe(2);
    expect(slept).toEqual([50]);
  });

  it("уважает Retry-After", async () => {
    const responses = [jsonResponse({}, 429, { "retry-after": "3" }), jsonResponse({}, 200)];
    const { fetch } = makeFetch((call) => responses[call - 1] ?? jsonResponse({}, 200));
    const slept: number[] = [];
    const wrapped = createMaxFetch({
      limiter: limiter(),
      baseFetch: fetch,
      retries: 1,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await wrapped("https://api/messages");
    expect(slept).toEqual([3000]);
  });

  it("не повторяет 400", async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({}, 400));
    const wrapped = createMaxFetch({ limiter: limiter(), baseFetch: fetch, retries: 3, sleep: async () => undefined });

    const response = await wrapped("https://api/messages");
    expect(response.status).toBe(400);
    expect(calls()).toBe(1);
  });

  it("повторяет сетевую ошибку, затем успех", async () => {
    const { fetch, calls } = makeFetch((call) => {
      if (call === 1) throw new Error("boom");
      return jsonResponse({}, 200);
    });
    const wrapped = createMaxFetch({ limiter: limiter(), baseFetch: fetch, retries: 2, sleep: async () => undefined });

    const response = await wrapped("https://api/messages");
    expect(response.status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("пробрасывает ошибку после исчерпания повторов", async () => {
    const { fetch } = makeFetch(() => {
      throw new Error("down");
    });
    const wrapped = createMaxFetch({ limiter: limiter(), baseFetch: fetch, retries: 1, sleep: async () => undefined });

    await expect(wrapped("https://api/messages")).rejects.toThrow("down");
  });

  it("parseRetryAfter: секунды, дата и мусор", () => {
    expect(parseRetryAfter("2", 0)).toBe(2000);
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("не-дата", 0)).toBeUndefined();
  });
});

describe("клавиатура", () => {
  const choice: StepView = {
    stepId: "who",
    type: "instruction",
    text: "Кто вы?",
    multiple: false,
    terminal: false,
    options: [
      { id: "person", label: "Я" },
      { id: "ip", label: "ИП" },
    ],
  };

  it("строит callback-кнопки из вариантов", () => {
    const keyboard = buildKeyboard(choice);
    expect(keyboard?.type).toBe("inline_keyboard");
    expect(keyboard?.payload.buttons).toHaveLength(1);
    expect(keyboard?.payload.buttons[0]).toHaveLength(2);
    expect(keyboard?.payload.buttons[0]?.[0]?.type).toBe("callback");
  });

  it("payload кодируется и декодируется", () => {
    const raw = encodeAnswerPayload({ stepId: "who", value: "person" });
    expect(decodeCallbackPayload(raw)).toEqual({ kind: "answer", stepId: "who", value: "person" });
  });

  it("распознаёт служебные кнопки", () => {
    expect(decodeCallbackPayload(NAV_BACK)).toEqual({ kind: "nav", action: "back" });
    expect(decodeCallbackPayload(NAV_RESTART)).toEqual({ kind: "nav", action: "restart" });
    expect(decodeCallbackPayload("мусор")).toBeUndefined();
  });

  it("распознаёт кнопки подсказки", () => {
    expect(decodeCallbackPayload("help:step")).toEqual({ kind: "help", target: "step" });
    expect(decodeCallbackPayload("help:checklist")).toEqual({ kind: "help", target: "checklist" });
  });

  it("добавляет кнопку «Не понятно»", () => {
    const keyboard = buildKeyboard(choice, {}, { help: "step" });
    const rows = keyboard?.payload.buttons ?? [];
    const last = rows.at(-1)?.[0];
    expect(last?.type).toBe("callback");
    expect((last as { payload: string }).payload).toBe("help:step");
  });

  it("инфо-шаг без вариантов и навигации не даёт клавиатуры", () => {
    const info: StepView = { stepId: "i", type: "instruction", text: "x", multiple: false, terminal: false, options: [] };
    expect(buildKeyboard(info)).toBeUndefined();
  });

  it("добавляет навигацию к вариантам", () => {
    const keyboard = buildKeyboard(choice, { back: true, restart: true });
    const rows = keyboard?.payload.buttons ?? [];
    expect(rows.at(-1)?.map((button) => button.text)).toEqual(["← Назад", "Начать заново"]);
  });

  it("длинные подписи — по одной в ряд", () => {
    const long: StepView = {
      stepId: "l",
      type: "instruction",
      text: "?",
      multiple: false,
      terminal: false,
      options: [
        { id: "a", label: "Очень длинный вариант ответа" },
        { id: "b", label: "Ещё один длинный вариант" },
      ],
    };
    expect(buildKeyboard(long)?.payload.buttons).toHaveLength(2);
  });
});

describe("MaxClient", () => {
  it("sendMessage кладёт текст в тело, chat_id — в query", async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined;
    const { fetch } = makeFetch((_call, url, init) => {
      captured = { url, init };
      return jsonResponse({
        message: {
          body: { mid: "m1", seq: 1, text: "привет" },
          recipient: { chat_id: 42, chat_type: "dialog", user_id: null, post_id: null },
          timestamp: 1,
        },
      });
    });

    const client = new MaxClient({ token: "tok", fetch });
    const message = await client.sendMessage({ chatId: 42, text: "привет" });

    expect(message.body.mid).toBe("m1");
    expect(captured?.url).toContain("chat_id=42");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("tok");
    expect(JSON.parse(String(captured?.init?.body))).toEqual({ text: "привет" });
  });

  it("sendMessage прокидывает вложения перед клавиатурой", async () => {
    let body: unknown;
    const { fetch } = makeFetch((_call, _url, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse({
        message: {
          body: { mid: "m1", seq: 1, text: "x" },
          recipient: { chat_id: 42, chat_type: "dialog", user_id: null, post_id: null },
          timestamp: 1,
        },
      });
    });
    const client = new MaxClient({ token: "tok", fetch });
    const view: StepView = {
      stepId: "s",
      type: "instruction",
      text: "?",
      multiple: false,
      terminal: false,
      options: [{ id: "a", label: "A" }],
    };
    const keyboard = buildKeyboard(view);
    await client.sendMessage({
      chatId: 42,
      text: "x",
      ...(keyboard ? { keyboard } : {}),
      attachments: [{ type: "image", payload: { url: "https://example.com/h.png" } }],
    });
    const parsed = body as { attachments?: Array<{ type: string }> };
    expect(parsed.attachments?.map((a) => a.type)).toEqual(["image", "inline_keyboard"]);
  });

  it("editMessage бросает MaxActionError при success:false", async () => {
    const { fetch } = makeFetch(() => jsonResponse({ success: false, message: "нельзя" }));
    const client = new MaxClient({ token: "tok", fetch });
    await expect(client.editMessage({ messageId: "m1", text: "x" })).rejects.toBeInstanceOf(MaxActionError);
  });

  it("editMessage не бросает при success:true", async () => {
    const { fetch } = makeFetch(() => jsonResponse({ success: true }));
    const client = new MaxClient({ token: "tok", fetch });
    await expect(client.editMessage({ messageId: "m1", text: "x" })).resolves.toBeUndefined();
  });

  it("answerCallback прокидывает notification в тело", async () => {
    let body: unknown;
    const { fetch } = makeFetch((_call, _url, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse({ success: true });
    });
    const client = new MaxClient({ token: "tok", fetch });
    await client.answerCallback({ callbackId: "c1", notification: "ок" });
    expect(body).toEqual({ notification: "ок" });
  });

  it("getMe возвращает данные бота", async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse({
        user_id: 7,
        name: "Фемида",
        first_name: "Фемида",
        username: "femida_bot",
        is_bot: true,
        last_activity_time: 1,
      }),
    );
    const client = new MaxClient({ token: "tok", fetch });
    const me = await client.getMe();
    expect(me.username).toBe("femida_bot");
    expect(me.user_id).toBe(7);
  });
});
