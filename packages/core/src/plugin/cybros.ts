export * as CybrosTrace from "./cybros"

import { InstallationVersion } from "../installation/version"
import { Bus } from "../bus"
import { SessionMessage } from "../session/message"
import { SessionStore } from "../session/store"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { DateTime, Effect, Stream } from "effect"

const url = "https://cybros.thape.com.cn/api/sigma_agents"

export function build(session: SessionSchema.Info, messages: readonly SessionMessage.Info[]) {
  return {
    session: {
      id: session.id,
      directory: session.location.directory,
      title: session.title,
      version: InstallationVersion,
      time_created: DateTime.toEpochMillis(session.time.created),
    },
    messages: messages.flatMap((message) => {
      if (message.type !== "assistant") return []
      return [
        {
          msgID: message.id,
          modelID: message.model.id,
          providerID: message.model.providerID,
          mode: message.agent,
          agent: message.agent,
          cost: message.cost,
          tokens: message.tokens,
        },
      ]
    }),
  }
}

export const Plugin = define({
  id: "opencode.cybros.trace",
  effect: Effect.fn(function* () {
    const sessions = yield* SessionStore.Service
    const bus = yield* Bus.Service
    // The legacy runner still publishes Idle while v2 Sessions publish execution terminal events.
    yield* bus
      .subscribe([
        SessionStatusEvent.Idle,
        SessionEvent.Execution.Succeeded,
        SessionEvent.Execution.Failed,
        SessionEvent.Execution.Interrupted,
      ])
      .pipe(
        Stream.runForEach((event) => trace(sessions, event.data.sessionID)),
        Effect.forkScoped,
      )
  }),
})

const trace = Effect.fn("CybrosTrace.trace")(function* (sessions: SessionStore.Interface, sessionID: SessionSchema.ID) {
  const session = yield* sessions.get(sessionID)
  if (!session) return
  const payload = build(session, yield* sessions.context(sessionID))
  yield* Effect.logInfo("session idle", payload).pipe(
    Effect.zip(post(payload, sessionID), { concurrent: true }),
    Effect.catchCause((cause) => Effect.logError("failed to write cybros trace", { sessionID, cause })),
  )
})

const post = Effect.fn("CybrosTrace.post")(function* (payload: ReturnType<typeof build>, sessionID: SessionSchema.ID) {
  const token = process.env.THAPE_SSO_BEARER_API_KEY
  if (!token)
    return yield* Effect.logDebug("skipping cybros trace upload; THAPE_SSO_BEARER_API_KEY not set", { sessionID })
  const response = yield* Effect.tryPromise(() =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    }),
  ).pipe(Effect.catch((error) => Effect.logWarning("failed to upload cybros trace", { sessionID, error })))
  if (!response || response.ok) return
  const body = yield* Effect.tryPromise(() => response.text()).pipe(Effect.orElseSucceed(() => ""))
  yield* Effect.logWarning("cybros trace upload returned non-OK status", {
    sessionID,
    status: response.status,
    statusText: response.statusText,
    body: body || undefined,
  })
})
