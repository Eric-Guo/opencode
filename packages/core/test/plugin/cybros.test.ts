import { expect, test } from "bun:test"
import { DateTime, Effect, Logger, Queue } from "effect"
import { Bus } from "@opencode/core/bus"
import { InstallationVersion } from "@opencode/core/installation/version"
import { Plugin } from "@opencode/core/plugin"
import { CybrosTrace } from "@opencode/core/plugin/cybros"
import { PluginHost } from "@opencode/core/plugin/host"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionStatusEvent } from "@opencode/schema/session-status-event"
import { Money } from "@opencode/schema/money"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

test("legacy trace builder supplies the installation version", () => {
  const created = DateTime.makeUnsafe(1_000)
  const session = Session.Info.make({
    id: Session.ID.make("ses_cybros"),
    projectID: Project.ID.global,
    title: "Trace",
    cost: Money.USD.make(0),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory: AbsolutePath.make("/workspace") },
    time: { created, updated: created },
  })

  expect(CybrosTrace.build(session, [], 450344).session).toMatchObject({
    id: session.id,
    version: InstallationVersion,
    work_package_id: 450344,
  })
})

const it = testEffect(PluginTestLayer)

it.live("the built-in adapter reads session and MyTodo state through the plugin event host", () =>
  withEnv({ THAPE_SSO_BEARER_API_KEY: undefined }, () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const projects = yield* Project.Service
      const plugins = yield* Plugin.Service
      const bus = yield* Bus.Service
      const host = yield* PluginHost.make(plugins, CybrosTrace.Plugin.id)
      const session = yield* sessions.create({ title: "Adapter trace", location: host.location })
      const logs = yield* Queue.unbounded<unknown>()

      yield* projects.update({
        projectID: session.projectID,
        myTodo: { project_id: 1, project_name: "Selected project", work_package_id: 450344 },
      })
      yield* CybrosTrace.Plugin.effect(host).pipe(
        Effect.provide(Logger.layer([Logger.make((entry) => Queue.offerUnsafe(logs, entry.message))])),
      )
      // Let the scoped subscription attach before publishing the idle event.
      yield* Effect.yieldNow
      yield* bus.publish(SessionStatusEvent.Idle, { sessionID: session.id })

      expect(yield* Queue.take(logs)).toEqual([
        "session idle",
        expect.objectContaining({
          session: expect.objectContaining({
            id: session.id,
            title: "Adapter trace",
            version: InstallationVersion,
            work_package_id: 450344,
          }),
          messages: [],
        }),
      ])
    }),
  ),
)
