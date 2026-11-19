import { randomUUID } from "node:crypto";
import type { Catalog } from "../catalog.js";
import { itemsByGroup, buildChecklist } from "../engine/checklist.js";
import { evaluateConditionsForCatalog } from "../engine/conditions.js";
import { progress } from "../engine/progress.js";
import { stepsById, type Scenario, type Step } from "../engine/scenario.js";
import { initialState } from "../engine/transition.js";
import type { Guides } from "../knowledge/guides.js";
import { answerHelp, type AssistDeps } from "../llm/assist.js";
import type { LlmClient } from "../llm/client.js";
import { buildKeyboard } from "../max/keyboard.js";
import type { RawUpdateRecord } from "../store/raw-updates.js";
import type { SessionRecord, Store, UserRecord } from "../store/index.js";
import type { SttClient } from "../stt/client.js";
import { parseUpdate, isUpdateLike, type AssistRequest } from "../updates.js";
import { formatProgress } from "./format.js";
import { runDialog, presentState } from "./orchestrator.js";
import { outcomeToScreens, type MessagePayload } from "./screens.js";

// Обработка одного входящего события: загрузить/создать сессию, прогнать
// движок, сохранить состояние и положить экраны в outbox. Всё внешнее
// (хранилище, время, генерация id, LLM, STT) передаётся снаружи — потому это
// тестируемо без Postgres, Redis, сети и модели.

export interface ProcessDeps {
  store: Store;
  scenario: Scenario;
  catalog: Catalog;
  /** Гайды «где получить» — нужны для подсказок помощника. */
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
  if (step && "text" in step && typeof step.text === "string") return step.text;
  return undefined;
}

// Собрать чек-лист по текущим ответам сессии (нужен помощнику для подсказок).
function checklistFor(deps: ProcessDeps, state: SessionRecord["state"]) {
  const conditions = evaluateConditionsForCatalog(deps.scenario, deps.catalog, state.answers);
  return buildChecklist(deps.catalog, deps.scenario, conditions);
}

export async function processRawUpdate(deps: ProcessDeps, raw: RawUpdateRecord): Promise<ProcessResult> {
  const now = deps.now ?? Date.now;
  const newPublicId = deps.newPublicId ?? ((): string => randomUUID());
  const maxSaveAttempts = deps.maxSaveAttempts ?? 3;

  if (!isUpdateLike(raw.payload)) return { status: "skipped", reason: "bad_payload" };

  const parsed = parseUpdate(raw.payload, now());
  if (raw.chatId === null || raw.userId === null) return { status: "skipped", reason: "no_chat" };

  const user = await deps.store.sessions.upsertUser({ maxUserId: raw.userId, chatId: raw.chatId });

  // Подсказка (текст, голос, кнопка «Не понятно») — состояние диалога не меняем.
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

    if (parsed.event.type === "answer") {
      await deps.store.sessions.appendAnswer({
        sessionId: session.id,
        stepId: parsed.event.stepId,
        value: parsed.event.value,
      });
    }

    for (const screen of outcomeToScreens(outcome, {
      chatId: raw.chatId,
      sessionId: session.id,
      sourceKey: raw.id,
      progressText: formatProgress(progress(deps.scenario, outcome.state.currentStep)),
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

// После ответа помощника возвращаем пользователю текущий вопрос с кнопками,
// чтобы он мог продолжить. Если сессии нет — предлагаем начать.
async function returnToDialog(deps: ProcessDeps, raw: RawUpdateRecord, session: SessionRecord | undefined): Promise<void> {
  const chatId = raw.chatId ?? 0;
  if (!session) {
    const restart = buildKeyboard(
      { stepId: "", type: "info", text: "", multiple: false, terminal: false, options: [] },
      { restart: true },
    );
    await deps.store.outbox.enqueue({
      chatId,
      sessionId: null,
      kind: "message",
      payload: {
        chatId,
        text: "Нажмите «Начать заново», чтобы пройти подбор документов.",
        format: "markdown",
        ...(restart ? { keyboard: restart } : {}),
      } satisfies MessagePayload,
      idempotencyKey: `${raw.id}:assist-start`,
    });
    return;
  }

  const outcome = presentState(deps.scenario, deps.catalog, session.state);
  for (const screen of outcomeToScreens(outcome, {
    chatId,
    sessionId: session.id,
    sourceKey: `${raw.id}:assist-return`,
    progressText: formatProgress(progress(deps.scenario, session.state.currentStep)),
  })) {
    await deps.store.outbox.enqueue(screen);
  }
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
      question = stepText ?? "Как пользоваться ботом и какие документы нужны?";
      break;
    case "checklist": {
      question = "Как получить документы из моего списка?";
      if (state) {
        const checklist = checklistFor(deps, state);
        documentCodes = [...itemsByGroup(checklist, "required"), ...itemsByGroup(checklist, "lawyer")].map(
          (item) => item.code,
        );
      }
      break;
    }
    case "voice": {
      if (!deps.stt) {
        await enqueueText(deps, raw, session, "Голосовые сообщения пока не поддерживаю — напишите вопрос текстом, и я подскажу.", "assist-voice");
        await returnToDialog(deps, raw, session);
        return { status: "done" };
      }
      let transcript: string | undefined;
      try {
        transcript = await deps.stt.transcribe({ url: assist.url });
      } catch (error) {
        deps.log?.("stt_failed", { message: error instanceof Error ? error.message : String(error) });
      }
      if (!transcript || transcript.trim() === "") {
        await enqueueText(deps, raw, session, "Не расслышал голосовое — попробуйте ещё раз или напишите текстом.", "assist-voice");
        await returnToDialog(deps, raw, session);
        return { status: "done" };
      }
      question = transcript;
      prefix = `🎤 «${transcript}»\n\n`;
      break;
    }
  }

  if (!deps.guides) {
    await enqueueText(deps, raw, session, `${prefix}Подсказки временно недоступны — вопрос уточнит юрист.`, "assist:0");
    await returnToDialog(deps, raw, session);
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
  await enqueueText(deps, raw, session, `${prefix}${answer.text}`, "assist:0");
  await returnToDialog(deps, raw, session);
  return { status: "done" };
}
