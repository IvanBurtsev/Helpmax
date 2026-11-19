import { z } from "zod";

// Конфигурация окружения. Читается один раз при старте и падает, если что-то
// не так — лучше упасть на старте, чем на первом сообщении клиента.

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(logLevels).default("info"),

    // MAX
    MAX_BOT_TOKEN: z.string().min(1).optional(),
    MAX_API_BASE: z.string().url().default("https://platform-api2.max.ru"),
    MAX_WEBHOOK_SECRET: z
      .string()
      .min(5)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/, "допустимы только символы [A-Za-z0-9_-]")
      .optional(),

    // Хранилища
    DATABASE_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),

    // Интеграция с сайтом
    SITE_BASE_URL: z.string().url().default("https://sales.femida-ai.ru"),
    SITE_SERVICE_TOKEN: z.string().min(1).optional(),
    INTERNAL_API_TOKEN: z.string().min(1).optional(),
    LINK_SIGNING_KEY: z.string().min(1).optional(),

    // LLM (подсказки по документам; DeepSeek — OpenAI-совместимый API)
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_BASE_URL: z.string().url().default("https://api.deepseek.com"),
    LLM_MODEL: z.string().min(1).default("deepseek-chat"),
    LLM_MAX_TOKENS: z.coerce.number().int().min(1).max(4000).default(1200),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20000),

    // STT (голос → текст). DeepSeek текст не распознаёт, нужен отдельный сервис.
    STT_API_KEY: z.string().min(1).optional(),
    STT_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    STT_MODEL: z.string().min(1).default("whisper-1"),
    STT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),

    // Контент
    CATALOG_PATH: z.string().min(1).default("content/catalog.json"),
    GUIDES_PATH: z.string().min(1).default("content/guides.json"),
    SCENARIO_PATH: z.string().min(1).default("content/scenarios/example.yaml"),

    // Визуал
    HERO_IMAGE_URL: z.string().url().optional(),

    // Воркер
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    OUTBOX_SWEEP_MS: z.coerce.number().int().min(1000).default(15000),

    // Прочее
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== "production") return;
    const required = ["MAX_BOT_TOKEN", "MAX_WEBHOOK_SECRET", "DATABASE_URL"] as const;
    for (const key of required) {
      if (!value[key]) {
        ctx.addIssue({ code: "custom", path: [key], message: "обязательно в production" });
      }
    }
  });

export type Config = z.infer<typeof envSchema>;

// В .env пустые значения (MAX_BOT_TOKEN=) означают «не задано».
function withoutEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(withoutEmpty(env));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Некорректная конфигурация окружения:\n${details}`);
  }
  return result.data;
}
