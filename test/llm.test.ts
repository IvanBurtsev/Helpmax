import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import { loadScenario } from "../src/engine/scenario.js";
import { loadGuides } from "../src/knowledge/guides.js";
import { answerHelp, fallbackAnswer } from "../src/llm/assist.js";
import { createLlmClient, LlmError, type LlmClient, type LlmMessage } from "../src/llm/client.js";
import { buildHelpMessages } from "../src/llm/prompt.js";
import { clampAnswer, sanitizeLinks } from "../src/llm/sanitize.js";

// Подсказки по документам: сборка промпта, клиент LLM, защита ссылок и откат.
// Всё без сети — транспорт подменяется.

const root = process.cwd();
const catalog = loadCatalog(path.join(root, "content", "catalog.json"));
const guides = loadGuides(path.join(root, "content", "guides.json"));
const scenario = loadScenario(path.join(root, "content", "scenarios", "example.yaml"));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("sanitizeLinks", () => {
  const allowed = new Set(["gosuslugi.ru", "femida-ai.ru"]);

  it("оставляет разрешённые ссылки и поддомены", () => {
    const { text, removed } = sanitizeLinks("Смотрите https://www.gosuslugi.ru и https://femida-ai.ru/x", allowed);
    expect(removed).toBe(0);
    expect(text).toContain("gosuslugi.ru");
  });

  it("вырезает выдуманные ссылки (markdown и голые)", () => {
    const result = sanitizeLinks("Перейдите [сюда](https://evil.example.com) или на https://phish.ru", allowed);
    expect(result.removed).toBe(2);
    expect(result.text).not.toContain("evil.example.com");
    expect(result.text).not.toContain("phish.ru");
    expect(result.text).toContain("сюда");
  });
});

describe("clampAnswer", () => {
  it("обрезает длинный ответ", () => {
    expect(clampAnswer("abcdef", 10)).toBe("abcdef");
    const out = clampAnswer("a".repeat(50), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildHelpMessages", () => {
  it("отделяет system от данных и включает документ и сервис", () => {
    const messages = buildHelpMessages({
      question: "Как получить паспорт?",
      scenarioTitle: "Банкротство физлица",
      stepText: "Кто вы?",
      documents: [
        { code: "other-passport", title: "Паспорт", source: "Прочие документы", howTo: "Оригинал и копии.", links: [] },
      ],
      services: [{ title: "Портал Госуслуг", url: "https://www.gosuslugi.ru" }],
      guideNote: "черновик",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("Паспорт");
    expect(messages[1]?.content).toContain("gosuslugi.ru");
    expect(messages[1]?.content).toContain("Как получить паспорт?");
  });
});

describe("createLlmClient", () => {
  it("шлёт запрос в /chat/completions с заголовком Authorization", async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined;
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      captured = { url: String(input), init };
      return jsonResponse({ choices: [{ message: { content: "Готово" } }] });
    }) as unknown as typeof globalThis.fetch;

    const client = createLlmClient({ apiKey: "secret", baseUrl: "https://api.deepseek.com", fetch });
    const text = await client.complete([{ role: "user", content: "привет" }]);

    expect(text).toBe("Готово");
    expect(captured?.url).toBe("https://api.deepseek.com/chat/completions");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer secret");
  });

  it("повторяет 500 и возвращает успех", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "boom" }, 500);
      return jsonResponse({ choices: [{ message: { content: "ок" } }] });
    }) as unknown as typeof globalThis.fetch;

    const client = createLlmClient({ apiKey: "k", fetch, sleep: async () => undefined, retries: 2 });
    expect(await client.complete([{ role: "user", content: "x" }])).toBe("ок");
    expect(calls).toBe(2);
  });

  it("не повторяет 401 и бросает LlmError", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonResponse({ error: "unauthorized" }, 401);
    }) as unknown as typeof globalThis.fetch;

    const client = createLlmClient({ apiKey: "k", fetch, sleep: async () => undefined, retries: 3 });
    await expect(client.complete([{ role: "user", content: "x" }])).rejects.toBeInstanceOf(LlmError);
    expect(calls).toBe(1);
  });
});

function fakeLlm(content: string): LlmClient {
  return { model: "fake", complete: async (_messages: LlmMessage[]) => content };
}

describe("answerHelp", () => {
  const deps = { catalog, guides, scenario };

  it("без LLM отдаёт откат из гайдов", async () => {
    const answer = await answerHelp(deps, { question: "как получить паспорт", documentCodes: ["other-passport"] });
    expect(answer.source).toBe("fallback");
    expect(answer.text).toContain("Паспорт");
  });

  it("с LLM возвращает ответ и вырезает недопустимые ссылки", async () => {
    const llm = fakeLlm("Смотрите https://evil.example.com и https://www.gosuslugi.ru");
    const answer = await answerHelp({ ...deps, llm }, { question: "где получить справку" });
    expect(answer.source).toBe("llm");
    expect(answer.text).not.toContain("evil.example.com");
    expect(answer.text).toContain("gosuslugi.ru");
  });

  it("при ошибке LLM откатывается на гайды", async () => {
    const llm: LlmClient = {
      model: "fake",
      complete: async () => {
        throw new Error("down");
      },
    };
    const answer = await answerHelp({ ...deps, llm }, { question: "x", documentCodes: ["other-passport"] });
    expect(answer.source).toBe("fallback");
    expect(answer.text).toContain("Паспорт");
  });

  it("fallbackAnswer упоминает документ и юриста", () => {
    const text = fallbackAnswer(deps, { question: "x", documentCodes: ["gosuslugi-ils"] });
    expect(text).toContain("юрист");
    expect(text).toContain("ИЛС");
  });
});
