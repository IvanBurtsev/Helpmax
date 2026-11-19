import { z } from "zod";

// Клиент LLM (OpenAI-совместимый, по умолчанию DeepSeek). Используется точечно:
// подсказка по документу/шагу, заземлённая на каталог и гайды. Модель не
// вызывает инструменты и не ходит в интернет — только возвращает текст.
//
// Свой HTTP-клиент здесь оправдан: SDK MAX к LLM отношения не имеет, а нужны
// таймаут, повторы и подмена fetch в тестах. Логика вызова отделена от
// оркестрации (assist), поэтому проверяется без сети.

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmClient {
  readonly model: string;
  complete(messages: LlmMessage[], options?: LlmCompleteOptions): Promise<string>;
}

export interface LlmClientOptions {
  apiKey: string;
  /** База без завершающего слэша, например https://api.deepseek.com */
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  retries?: number;
  /** Подмена транспорта (тесты). */
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }).optional(),
        text: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function withTimeout(init: RequestInit, timeoutMs: number, external?: AbortSignal): RequestInit {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = external ? AbortSignal.any([external, timeout]) : timeout;
  return { ...init, signal };
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 600;
  const temperature = options.temperature ?? 0.2;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retries = options.retries ?? 2;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function once(messages: LlmMessage[], opts: LlmCompleteOptions): Promise<string> {
    const body = {
      model,
      messages,
      max_tokens: opts.maxTokens ?? maxTokens,
      temperature: opts.temperature ?? temperature,
      stream: false,
    };
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body),
    };
    const response = await doFetch(`${baseUrl}/chat/completions`, withTimeout(init, timeoutMs, opts.signal));
    const text = await response.text();
    if (!response.ok) {
      throw new LlmError(`LLM HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmError("LLM вернул не-JSON");
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new LlmError("LLM вернул неожиданную структуру");
    const choice = parsed.data.choices[0];
    const content = choice?.message?.content ?? choice?.text ?? "";
    return content.trim();
  }

  return {
    model,
    async complete(messages, opts = {}) {
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          return await once(messages, opts);
        } catch (error) {
          lastError = error;
          const status = error instanceof LlmError ? error.status : undefined;
          const retryable = status === undefined || RETRY_STATUS.has(status);
          if (attempt < retries && retryable) {
            await sleep(300 * 2 ** attempt);
            continue;
          }
          break;
        }
      }
      throw lastError instanceof Error ? lastError : new LlmError("LLM: запрос не удался");
    },
  };
}
