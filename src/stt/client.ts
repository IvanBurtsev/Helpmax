import { z } from "zod";

// Распознавание речи (голос → текст). DeepSeek — текстовая модель, поэтому для
// голосовых сообщений нужен отдельный STT. Здесь OpenAI-совместимый endpoint
// /audio/transcriptions (Whisper и совместимые сервисы). Если STT не настроен —
// голосовые не принимаем, а вежливо просим написать текстом.

export interface SttClient {
  transcribe(input: { url: string }): Promise<string>;
}

export interface SttClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const responseSchema = z.object({ text: z.string().optional() });

export class SttError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SttError";
  }
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "whisper-1";

export function createSttClient(options: SttClientOptions): SttClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const language = options.language ?? "ru";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async transcribe({ url }) {
      const audio = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!audio.ok) throw new SttError(`не удалось скачать аудио: HTTP ${audio.status}`, audio.status);
      const buffer = await audio.arrayBuffer();
      const contentType = audio.headers.get("content-type") ?? "audio/ogg";

      const form = new FormData();
      form.append("file", new Blob([buffer], { type: contentType }), "voice.ogg");
      form.append("model", model);
      form.append("language", language);

      const response = await doFetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new SttError(`STT HTTP ${response.status}: ${text.slice(0, 200)}`, response.status);

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new SttError("STT вернул не-JSON");
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) throw new SttError("STT вернул неожиданную структуру");
      return (parsed.data.text ?? "").trim();
    },
  };
}
