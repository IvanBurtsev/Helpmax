import type { FetchFn } from "@maxhub/max-bot-api";
import type { TokenBucket } from "./rate-limit.js";

// Обёртка над fetch для MAX: лимит частоты, таймаут и повторы.
// Стоит НИЖЕ SDK (передаётся в clientOptions.fetch), поэтому через неё
// проходят все запросы, включая повторы и загрузки.

export interface RetryPolicy {
  /** Повторов после первой попытки. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  retries: 3,
  baseDelayMs: 300,
  maxDelayMs: 5000,
  timeoutMs: 15000,
};

// Повторяем только то, что имеет смысл повторять. 400/401/403 — это наша
// ошибка, повтор её не исправит.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export interface MaxFetchOptions extends Partial<RetryPolicy> {
  limiter: TokenBucket;
  sleep?: (ms: number) => Promise<void>;
  /** Источник случайности для джиттера, 0..1 (тесты). */
  random?: () => number;
  /** Подмена нижнего fetch (тесты). */
  baseFetch?: FetchFn;
}

// Retry-After: секунды или HTTP-дата. Возвращает миллисекунды.
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function withTimeout(init: RequestInit | undefined, timeoutMs: number): RequestInit {
  const timeout = AbortSignal.timeout(timeoutMs);
  const base: RequestInit = init ?? {};
  // Сохраняем сигнал вызывающего (например, отмену по shutdown).
  const signal = base.signal ? AbortSignal.any([base.signal, timeout]) : timeout;
  return { ...base, signal };
}

export function createMaxFetch(options: MaxFetchOptions): FetchFn {
  const retries = options.retries ?? DEFAULT_RETRY.retries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RETRY.timeoutMs;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const baseFetch = options.baseFetch ?? globalThis.fetch;

  // Экспоненциальная задержка с джиттером: 50–100% от потолка.
  const backoff = (attempt: number): number => {
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    return Math.round(ceiling * (0.5 + random() * 0.5));
  };

  return async (input, init) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await options.limiter.acquire();
      try {
        const response = await baseFetch(input, withTimeout(init, timeoutMs));
        if (RETRY_STATUS.has(response.status) && attempt < retries) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"), Date.now());
          await sleep(retryAfter ?? backoff(attempt));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("MAX fetch: запрос не удался");
  };
}
