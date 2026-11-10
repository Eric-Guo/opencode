import { afterEach, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { EventDomain } from "@opencode/plugin/effect/event"
import { Agent } from "@opencode/schema/agent"
import { Event } from "@opencode/schema/event"
import { Model } from "@opencode/schema/model"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionStatusEvent } from "@opencode/schema/session-status-event"
import { Money } from "@opencode/schema/money"
import { DateTime, Deferred, Effect, Logger, Stream } from "effect"
import { CybrosTrace } from "../src/cybros.js"
import { http } from "./http.js"

const original = process.env.THAPE_SSO_BEARER_API_KEY

afterEach(() => {
  if (original === undefined) {
    delete process.env.THAPE_SSO_BEARER_API_KEY
    return
  }

  process.env.THAPE_SSO_BEARER_API_KEY = original
})

function snapshot(workPackageID?: number): CybrosTrace.Snapshot {
  const created = DateTime.makeUnsafe(1_000)

  return {
    session: Session.Info.make({
      id: Session.ID.make("ses_cybros"),
      projectID: Project.ID.global,
      title: "Trace",
      cost: Money.USD.make(0),
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      location: { directory: AbsolutePath.make("/workspace") },
      time: { created, updated: created },
    }),
    messages: [
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_cybros"),
        type: "assistant",
        agent: Agent.ID.make("build"),
        model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
        content: [],
        cost: Money.USD.make(0.25),
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        time: { created, completed: created },
      }),
      SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_user"),
        type: "user",
        text: "Hello",
        time: { created },
      }),
    ],
    workPackageID,
  }
}

test.each([undefined, 450344])("builds the Cybros trace with selected work package %s", (workPackageID) => {
  expect(CybrosTrace.build(snapshot(workPackageID), "test-version")).toEqual({
    session: {
      id: Session.ID.make("ses_cybros"),
      directory: AbsolutePath.make("/workspace"),
      title: "Trace",
      ...(workPackageID === undefined ? {} : { work_package_id: workPackageID }),
      version: "test-version",
      time_created: 1_000,
    },
    messages: [
      {
        msgID: SessionMessage.ID.make("msg_cybros"),
        modelID: Model.ID.make("model"),
        providerID: Provider.ID.make("provider"),
        mode: Agent.ID.make("build"),
        agent: Agent.ID.make("build"),
        cost: Money.USD.make(0.25),
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      },
    ],
  })
})

test.each(["success", "no-token", "http-error", "network-error"])(
  "traces terminal events and closes its subscription: %s",
  async (scenario) => {
    if (scenario === "no-token") delete process.env.THAPE_SSO_BEARER_API_KEY
    if (scenario !== "no-token") process.env.THAPE_SSO_BEARER_API_KEY = "sso-token"

    const value = snapshot(450344)
    const uploads: unknown[] = []
    const reads: Session.ID[] = []
    const types: string[] = []
    const missing = Session.ID.make("ses_missing")
    const envelope = { id: Event.ID.create(), created: 1_000, data: { sessionID: value.session.id } }
    const durable = { aggregateID: value.session.id, seq: Event.Seq.make(0), version: Event.Version.make(1) }
    const events = [
      SessionStatusEvent.Idle.make({ ...envelope, type: "session.idle" }),
      SessionEvent.Execution.Succeeded.make({ ...envelope, durable, type: "session.execution.succeeded" }),
      SessionEvent.Execution.Failed.make({
        ...envelope,
        durable,
        type: "session.execution.failed",
        data: { ...envelope.data, error: { type: "unknown", message: "failed" } },
      }),
      SessionEvent.Execution.Interrupted.make({
        ...envelope,
        durable,
        type: "session.execution.interrupted",
        data: { ...envelope.data, reason: "user" },
      }),
      SessionStatusEvent.Idle.make({ ...envelope, type: "session.idle", data: { sessionID: missing } }),
    ]
    let closed = false
    let requests = 0

    using server = http(async (request) => {
      expect(request.method).toBe("POST")
      expect(request.headers.get("Authorization")).toBe("Bearer sso-token")
      expect(request.headers.get("Accept")).toBe("application/json")
      expect(request.headers.get("Content-Type")).toBe("application/json")
      uploads.push(await request.json())

      return new Response(scenario === "http-error" ? "unavailable" : null, {
        status: scenario === "http-error" ? 503 : 204,
      })
    })

    await Effect.gen(function* () {
      const done = yield* Deferred.make<void>()
      const plugin = CybrosTrace.create({
        version: "test-version",
        read: (sessionID) => {
          reads.push(sessionID)
          if (sessionID === missing) return Deferred.succeed(done, undefined).pipe(Effect.as(undefined))

          return Effect.succeed(value)
        },
        request: (url, init) => {
          requests++
          if (scenario === "network-error") return Promise.reject(new Error("offline"))

          return server.request(url, init)
        },
      })

      expect(plugin.id).toBe("opencode.cybros.trace")

      yield* plugin.effect({
        event: {
          // This fixture emits only the requested event types; the generic API cannot infer the narrowing.
          subscribe: ((input) => {
            types.push(...(input?.types ?? []))

            return Stream.fromIterable(events).pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(Effect.sync(() => (closed = true))),
            )
          }) as EventDomain["subscribe"],
        },
      } as Context)
      yield* Deferred.await(done)
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([])), Effect.runPromise)

    expect(types).toEqual([
      "session.idle",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ])
    expect(reads).toEqual([...Array<Session.ID>(4).fill(value.session.id), missing])
    expect(closed).toBe(true)
    expect(requests).toBe(scenario === "no-token" ? 0 : 4)
    expect(uploads).toEqual(
      scenario === "no-token" || scenario === "network-error"
        ? []
        : Array.from({ length: 4 }, () => CybrosTrace.build(value, "test-version")),
    )
    expect(server.urls.every((url) => url === "https://cybros.thape.com.cn/api/sigma_agents")).toBe(true)
  },
)
