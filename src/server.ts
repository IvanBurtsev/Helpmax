import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";

// Каркас (шаг 3 плана). Пока только приём webhook и health-check.
// Очередь, движок и хранилища добавятся следующими шагами.

loadDotEnv();

const config = loadConfig();

const app = Fastify({
  logger: { level: config.LOG_LEVEL },
});

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

app.get("/healthz", async () => ({ status: "ok" }));

// MAX присылает сюда события. Проверяем секрет и отвечаем 200 сразу;
// обработка события — асинхронно (очередь, шаг 3).
app.post("/webhook", async (request, reply) => {
  const secret = config.MAX_WEBHOOK_SECRET ?? "";
  const got = request.headers["x-max-bot-api-secret"];

  if (!secret || typeof got !== "string" || !safeEqual(got, secret)) {
    return reply.code(403).send({ ok: false });
  }

  return reply.code(200).send({ ok: true });
});

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
