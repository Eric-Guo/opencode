export * as CybrosTrace from "./cybros.js"

import { define, type Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionStatusEvent } from "@opencode/schema/session-status-event"
import { DateTime, Effect, Stream } from "effect"

const url = "https://cybros.thape.com.cn/api/sigma_agents"

export const ID = "opencode.cybros.trace"

export interface Snapshot {
  readonly session: Session.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly workPackageID?: number
}

export interface Options<E = never, R = never> {
  readonly version: string
  readonly read: (sessionID: Session.ID) => Effect.Effect<Snapshot | undefined, E, R>
  readonly request?: (url: string, init: RequestInit) => Promise<Response>
}

export function build(snapshot: Snapshot, version: string) {
  return {
    session: {
      id: snapshot.session.id,
      directory: snapshot.session.location.directory,
      title: snapshot.session.title,
      ...(snapshot.workPackageID === undefined ? {} : { work_package_id: snapshot.workPackageID }),
      version,
      time_created: DateTime.toEpochMillis(snapshot.session.time.created),
    },
    messages: snapshot.messages.flatMap((message) => {
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

export function create<E, R>(input: Options<E, R>) {
  return define({
    id: ID,
    effect: Effect.fn(function* (ctx: Context) {
      // Legacy Sessions publish idle; current Sessions publish execution terminal events.
      yield* ctx.event
        .subscribe({
          types: [
            SessionStatusEvent.Idle.type,
            SessionEvent.Execution.Succeeded.type,
            SessionEvent.Execution.Failed.type,
            SessionEvent.Execution.Interrupted.type,
          ],
        })
        .pipe(
          Stream.runForEach((event) => trace(input, event.data.sessionID)),
          Effect.forkScoped,
        )
    }),
  })
}

const trace = Effect.fn("CybrosTrace.trace")(function* <E, R>(input: Options<E, R>, sessionID: Session.ID) {
  const snapshot = yield* input.read(sessionID)
  if (!snapshot) return

  const payload = build(snapshot, input.version)

  yield* Effect.logInfo("session idle", payload).pipe(
    Effect.zip(post(payload, sessionID, input.request ?? fetch), { concurrent: true }),
    Effect.catchCause((cause) => Effect.logError("failed to write cybros trace", { sessionID, cause })),
  )
})

const post = Effect.fn("CybrosTrace.post")(function* (
  payload: ReturnType<typeof build>,
  sessionID: Session.ID,
  request: (url: string, init: RequestInit) => Promise<Response>,
) {
  const token = process.env.THAPE_SSO_BEARER_API_KEY
  if (!token)
    return yield* Effect.logDebug("skipping cybros trace upload; THAPE_SSO_BEARER_API_KEY not set", { sessionID })

  const response = yield* Effect.tryPromise(() =>
    request(url, {
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
