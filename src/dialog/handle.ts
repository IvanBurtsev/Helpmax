import type { Catalog } from "../catalog.js";
import type { Scenario } from "../engine/scenario.js";
import type { Guides } from "../knowledge/guides.js";
import type { LlmClient } from "../llm/client.js";
import type { MaxClient } from "../max/client.js";
import type { RawUpdateRecord } from "../store/raw-updates.js";
import type { Store } from "../store/index.js";
import type { SttClient } from "../stt/client.js";
import { processRawUpdate, type ProcessResult } from "./process.js";

// Обработка одного события, начиная с записи в `raw_updates`: погасить
// индикатор нажатой кнопки, прогнать движок и отметить статус записи. Общая
// для воркера (webhook) и для long polling — отличается только то, что
// делается после: постановка задачи в очередь или прямая доставка.

export interface HandleDeps {
  store: Store;
  scenario: Scenario;
  catalog: Catalog;
  /** Нужен только для ответа на нажатие кнопки; остальное — через outbox. */
  max: Pick<MaxClient, "answerCallback">;
  guides?: Guides;
  llm?: LlmClient;
  stt?: SttClient;
  heroUrl?: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  newPublicId?: () => string;
}

export function readCallbackId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const callback = (payload as { callback?: unknown }).callback;
  if (typeof callback !== "object" || callback === null) return undefined;
  const id = (callback as { callback_id?: unknown }).callback_id;
  return typeof id === "string" ? id : undefined;
}

// Ответ на нажатие кнопки останавливает индикатор ожидания в MAX. Ошибку не
// считаем фатальной: экран пользователь всё равно получит через outbox.
export async function answerCallback(
  max: Pick<MaxClient, "answerCallback">,
  payload: unknown,
): Promise<void> {
  const callbackId = readCallbackId(payload);
  if (!callbackId) return;
  try {
    await max.answerCallback({ callbackId });
  } catch {
    // необязательный шаг
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Разбирает запись `raw_updates`. Если обработка упала, запись помечается
// `failed`, а ошибка пробрасывается дальше — чтобы вызывающий (воркер) мог
// повторить задачу.
export async function handleRawUpdate(deps: HandleDeps, raw: RawUpdateRecord): Promise<ProcessResult> {
  if (raw.updateType === "message_callback") await answerCallback(deps.max, raw.payload);

  try {
    const result = await processRawUpdate(
      {
        store: deps.store,
        scenario: deps.scenario,
        catalog: deps.catalog,
        ...(deps.guides ? { guides: deps.guides } : {}),
        ...(deps.llm ? { llm: deps.llm } : {}),
        ...(deps.stt ? { stt: deps.stt } : {}),
        ...(deps.heroUrl ? { heroUrl: deps.heroUrl } : {}),
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.newPublicId ? { newPublicId: deps.newPublicId } : {}),
      },
      raw,
    );
    const status = result.status === "done" ? "done" : result.status === "skipped" ? "skipped" : "failed";
    await deps.store.rawUpdates.markProcessed(raw.id, status, result.reason);
    return result;
  } catch (error) {
    await deps.store.rawUpdates.markProcessed(raw.id, "failed", describe(error));
    throw error;
  }
}
