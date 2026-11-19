import { randomUUID } from "node:crypto";
import type { Catalog } from "../catalog.js";
import type { Scenario } from "../engine/scenario.js";
import { initialState } from "../engine/transition.js";
import type { RawUpdateRecord } from "../store/raw-updates.js";
import type { SessionRecord, Store } from "../store/index.js";
import { parseUpdate, isUpdateLike } from "../updates.js";
import { runDialog } from "./orchestrator.js";
import { outcomeToScreens } from "./screens.js";

// Обработка одного входящего события: загрузить/создать сессию, прогнать
// движок, сохранить состояние и положить экраны в outbox. Всё внешнее
// (хранилище, время, генерация id) передаётся снаружи — потому это тестируемо
// без Postgres, Redis и сети.

export interface ProcessDeps {
  store: Store;
  scenario: Scenario;
  catalog: Catalog;
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

export async function processRawUpdate(deps: ProcessDeps, raw: RawUpdateRecord): Promise<ProcessResult> {
  const now = deps.now ?? Date.now;
  const newPublicId = deps.newPublicId ?? ((): string => randomUUID());
  const maxSaveAttempts = deps.maxSaveAttempts ?? 3;

  if (!isUpdateLike(raw.payload)) return { status: "skipped", reason: "bad_payload" };

  const parsed = parseUpdate(raw.payload, now());
  if (!parsed.event) return { status: "skipped", reason: "no_dialog_event" };
  if (raw.chatId === null || raw.userId === null) return { status: "skipped", reason: "no_chat" };

  const user = await deps.store.sessions.upsertUser({ maxUserId: raw.userId, chatId: raw.chatId });

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
    })) {
      await deps.store.outbox.enqueue(screen);
    }

    return { status: "done" };
  }

  return { status: "failed", reason: "session_conflict" };
}
