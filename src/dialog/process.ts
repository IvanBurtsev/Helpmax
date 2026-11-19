import { randomUUID } from "node:crypto";
import type { Catalog } from "../catalog.js";
import { stepsById, type Scenario, type Step } from "../engine/scenario.js";
import { initialState } from "../engine/transition.js";
import type { Guides } from "../knowledge/guides.js";
import { answerHelp, type AssistDeps } from "../llm/assist.js";
import type { LlmClient } from "../llm/client.js";
import { buildAssistKeyboard } from "../max/keyboard.js";
import type { RawUpdateRecord } from "../store/raw-updates.js";
import type { SessionRecord, Store, UserRecord } from "../store/index.js";
import type { SttClient } from "../stt/client.js";
import { parseUpdate, isUpdateLike, type AssistRequest } from "../updates.js";
import { runDialog } from "./orchestrator.js";
import { outcomeToScreens, type MessagePayload } from "./screens.js";

// Обработка одного входящего события: загрузить/создать сессию, прогнать
// движок, сохранить состояние и положить экраны в outbox. Всё внешнее
// (хранилище, время, генерация id, LLM, STT) передаётся снаружи — потому это
// тестируемо без Postgres, Redis, сети и модели.
//
// Опросника нет: на «Начать» сразу показываем инструкцию по документам.
// Свободный текст, голос и кнопка подсказки идут помощнику и состояние
// диалога не меняют.

export interface ProcessDeps {
  store: Store;
  scenario: Scenario;
  catalog: Catalog;
  /** Гайды «где получить» — обогащают инструкцию и подсказки помощника. */
  guides?: Guides;
  /** Клиент LLM — подсказки по документам. Без него работает откат на гайды. */
  llm?: LlmClient;
  /** Распознавание речи для голосовых сообщений. */
  stt?: SttClient;
  /** Картинка-шапка на стартовом экране (публичный URL). */
  heroUrl?: string;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  newPublicId?: () => string;
  /** Сколько раз перечитать сессию при конфликте версии. */
  maxSaveAttempts?: number;
}

export type ProcessStatus = "done" | "skipped" | "failed";

export interface ProcessResult {
  status: ProcessStatus;
  reason?: string;
}

function stepTextOf(step: Step | undefined): string | undefined {
  if (!step) return undefined;
  return step.title ?? step.text;
}

export async function processRawUpdate(deps: ProcessDeps, raw: RawUpdateRecord): Promise<ProcessResult> {
  const now = deps.now ?? Date.now;
  const newPublicId = deps.newPublicId ?? ((): string => randomUUID());
  const maxSaveAttempts = deps.maxSaveAttempts ?? 3;

  if (!isUpdateLike(raw.payload)) return { status: "skipped", reason: "bad_payload" };

  const parsed = parseUpdate(raw.payload, now());
  if (raw.chatId === null || raw.userId === null) return { status: "skipped", reason: "no_chat" };

  const user = await deps.store.sessions.upsertUser({ maxUserId: raw.userId, chatId: raw.chatId });

  // Подсказка (текст, голос, кнопка) — состояние диалога не меняем.
  if (parsed.assist) return handleAssist(deps, raw, parsed.assist, user);

  if (!parsed.event) return { status: "skipped", reason: "no_dialog_event" };

  const isStart = parsed.event.type === "start";
  if (isStart) await deps.store.sessions.abandonActiveSessions(user.id);

  let session: SessionRecord | undefined = isStart
    ? undefined
    : await deps.store.sessions.getActiveSession(user.id);

  if (!session) {
    session = await deps.store.sessions.createSession({
      publicId: newPublicId(),
      userId: user.id,
      scenarioCode: deps.scenario.code,
      scenarioVersion: deps.scenario.version,
      catalogVersion: deps.catalog.version,
      state: initialState(deps.scenario),
      currentStep: deps.scenario.start,
    });
  }

  for (let attempt = 0; attempt < maxSaveAttempts; attempt += 1) {
    const outcome = runDialog({
      scenario: deps.scenario,
      catalog: deps.catalog,
      ...(deps.guides ? { guides: deps.guides } : {}),
      state: session.state,
      event: parsed.event,
    });

    if (outcome.status === "noop") {
      return { status: "skipped", reason: outcome.reason ?? "noop" };
    }

    const version = await deps.store.sessions.saveState({
      id: session.id,
      expectedVersion: session.version,
      state: outcome.state,
      currentStep: outcome.state.currentStep,
      status: outcome.terminal ? "completed" : "active",
    });

    if (version === undefined) {
      // Кто-то изменил сессию между чтением и записью — перечитываем и повторяем.
      const fresh = await deps.store.sessions.getActiveSession(user.id);
      if (!fresh) return { status: "failed", reason: "session_conflict" };
      session = fresh;
      continue;
    }

    for (const screen of outcomeToScreens(outcome, {
      chatId: raw.chatId,
      sessionId: session.id,
      sourceKey: raw.id,
      ...(isStart && deps.heroUrl ? { heroUrl: deps.heroUrl } : {}),
    })) {
      await deps.store.outbox.enqueue(screen);
    }

    return { status: "done" };
  }

  return { status: "failed", reason: "session_conflict" };
}

// ---------- Помощник (LLM + STT) ----------

async function enqueueText(
  deps: ProcessDeps,
  raw: RawUpdateRecord,
  session: SessionRecord | undefined,
  text: string,
  suffix: string,
  keyboard?: MessagePayload["keyboard"],
): Promise<void> {
  const payload: MessagePayload = {
    chatId: raw.chatId ?? 0,
    text,
    format: "markdown",
    ...(keyboard ? { keyboard } : {}),
  };
  await deps.store.outbox.enqueue({
    chatId: raw.chatId ?? 0,
    sessionId: session?.id ?? null,
    kind: "message",
    payload,
    idempotencyKey: `${raw.id}:${suffix}`,
  });
}

async function handleAssist(
  deps: ProcessDeps,
  raw: RawUpdateRecord,
  assist: AssistRequest,
  user: UserRecord,
): Promise<ProcessResult> {
  const session = await deps.store.sessions.getActiveSession(user.id);
  const state = session?.state;
  const step = state ? stepsById(deps.scenario).get(state.currentStep) : undefined;
  const stepText = stepTextOf(step);

  let question = "";
  let prefix = "";
  let documentCodes: string[] | undefined;

  switch (assist.kind) {
    case "text":
      question = assist.text;
      break;
    case "step":
      question = stepText ?? "Как получить документы и как пользоваться ботом?";
      break;
    case "checklist":
      question = "Как получить документы из списка?";
      documentCodes = deps.catalog.documents.map((doc) => doc.code);
      break;
    case "voice": {
      if (!deps.stt) {
        await enqueueText(
          deps,
          raw,
          session,
          "Голосовые сообщения пока не поддерживаю — напишите вопрос текстом, и я подскажу.",
          "assist-voice",
          buildAssistKeyboard(),
        );
        return { status: "done" };
      }
      let transcript: string | undefined;
      try {
        transcript = await deps.stt.transcribe({ url: assist.url });
      } catch (error) {
        deps.log?.("stt_failed", { message: error instanceof Error ? error.message : String(error) });
      }
      if (!transcript || transcript.trim() === "") {
        await enqueueText(
          deps,
          raw,
          session,
          "Не расслышал голосовое — попробуйте ещё раз или напишите текстом.",
          "assist-voice",
          buildAssistKeyboard(),
        );
        return { status: "done" };
      }
      question = transcript;
      prefix = `🎤 «${transcript}»\n\n`;
      break;
    }
  }

  const keyboard = buildAssistKeyboard();

  if (!deps.guides) {
    await enqueueText(deps, raw, session, `${prefix}Подсказки временно недоступны — вопрос уточнит юрист.`, "assist:0", keyboard);
    return { status: "done" };
  }

  const assistDeps: AssistDeps = {
    catalog: deps.catalog,
    guides: deps.guides,
    scenario: deps.scenario,
    ...(deps.llm ? { llm: deps.llm } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  };

  const answer = await answerHelp(assistDeps, {
    question,
    ...(stepText ? { stepText } : {}),
    ...(documentCodes ? { documentCodes } : {}),
  });

  deps.log?.("assist_answered", { source: answer.source, kind: assist.kind });
  await enqueueText(deps, raw, session, `${prefix}${answer.text}`, "assist:0", keyboard);
  return { status: "done" };
}
