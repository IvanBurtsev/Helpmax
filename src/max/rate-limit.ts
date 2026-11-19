// Токен-бакет: ограничивает частоту запросов к MAX. У API лимит 30 rps,
// держим 25 — с запасом на всплески и на другие интеграции с тем же токеном.
// Часы и sleep инъектируются, поэтому логика тестируется без реального времени.

export interface TokenBucketOptions {
  /** Максимальный всплеск: сколько запросов можно отправить сразу. */
  capacity: number;
  /** Пополнение, токенов в секунду. */
  refillPerSecond: number;
  /** Часы в миллисекундах (по умолчанию Date.now). */
  now?: () => number;
  /** Ожидание (по умолчанию setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  // Запросы обслуживаются по очереди: без этого при всплеске несколько
  // корутин одновременно увидели бы свободный токен и превысили лимит.
  private queue: Promise<void> = Promise.resolve();

  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0) throw new Error("capacity должен быть > 0");
    if (options.refillPerSecond <= 0) throw new Error("refillPerSecond должен быть > 0");
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = options.capacity;
    this.lastRefill = this.now();
  }

  /** Сколько токенов доступно прямо сейчас. */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /** Ждёт и забирает один токен. Вызовы обслуживаются по очереди (FIFO). */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.waitForToken());
    // Ошибку в очереди не пробрасываем дальше: иначе следующий вызов
    // застрянет на уже отклонённом промисe.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;
  }

  private async waitForToken(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const missing = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil((missing / this.refillPerSecond) * 1000));
      await this.sleep(waitMs);
    }
  }
}
