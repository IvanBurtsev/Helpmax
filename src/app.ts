import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { RawUpdatesRepo } from "./store/raw-updates.js";
import { isUpdateLike, parseUpdate } from "./updates.js";

// HTTP-приложение: health-check и приём webhook MAX. Логика тонкая — проверить
// секрет, записать событие и поставить в очередь; тяжёлая работа в воркере.
// Зависимости передаются снаружи, поэтому маршруты тестируются через inject().

export interface AppDeps {
  config: Config;
  rawUpdates: RawUpdatesRepo;
  /** Ставит событие в очередь обработки по id записи raw_updates. */
  enqueueUpdate: (rawUpdateId: string) => Promise<void>;
  now?: () => number;
  /** Отключить лог (тесты). */
  logger?: boolean;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    logger: deps.logger === false ? false : { level: deps.config.LOG_LEVEL },
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/webhook", async (request, reply) => {
    const secret = deps.config.MAX_WEBHOOK_SECRET ?? "";
    const got = request.headers["x-max-bot-api-secret"];

    if (!secret || typeof got !== "string" || !safeEqual(got, secret)) {
      return reply.code(403).send({ ok: false });
    }

    const body: unknown = request.body;
    if (!isUpdateLike(body)) {
      // Некорректное тело повторять бессмысленно: отвечаем 200, чтобы MAX
      // не зациклил доставку, но фиксируем в логе.
      request.log.warn("webhook: тело не похоже на событие MAX");
      return reply.code(200).send({ ok: false, reason: "bad_update" });
    }

    const parsed = parseUpdate(body, now());
    const inserted = await deps.rawUpdates.insert({
      dedupeKey: parsed.dedupeKey,
      updateType: parsed.updateType,
      chatId: parsed.chatId,
      userId: parsed.userId,
      payload: body,
      late: parsed.late,
    });

    if (inserted.duplicate || !inserted.id) {
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    await deps.enqueueUpdate(inserted.id);
    return reply.code(200).send({ ok: true });
  });

  return app;
}
