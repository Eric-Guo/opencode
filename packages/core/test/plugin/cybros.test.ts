import { expect } from "bun:test"
import { Effect, Logger, Queue } from "effect"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { InstallationVersion } from "@opencode/core/installation/version"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginInternal } from "@opencode/core/plugin/internal"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { SessionStatusEvent } from "@opencode/schema/session-status-event"
import { CybrosTrace } from "@opencode/thape/cybros"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { withEnv } from "../fixture/env"
import { tempLocationLayer } from "../fixture/location"
import { offlineModels } from "../fixture/models"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([PluginInternal.requirements, Plugin.node]), [
    Location.node.replace(tempLocationLayer),
    Config.node.replace(Config.testLayer()),
    offlineModels,
  ]),
)

it.live("the built-in adapter reads session and MyTodo state through the plugin event host", () =>
  withEnv({ THAPE_SSO_BEARER_API_KEY: undefined }, () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const projects = yield* Project.Service
      const plugins = yield* Plugin.Service
      const bus = yield* Bus.Service
      const location = yield* Location.Service
      const internal = yield* PluginInternal.list()
      const session = yield* sessions.create({ title: "Adapter trace", location })
      const logs = yield* Queue.unbounded<unknown>()

      yield* projects.update({
        projectID: session.projectID,
        myTodo: { project_id: 1, project_name: "Selected project", work_package_id: 450344 },
      })
      yield* plugins.activate(internal.pre.filter((plugin) => plugin.id === CybrosTrace.ID)).pipe(
        Effect.provide(Logger.layer([Logger.make((entry) => Queue.offerUnsafe(logs, entry.message))])),
      )
      expect(yield* plugins.list()).toMatchObject([
        { id: CybrosTrace.ID, source: { type: "builtin" }, state: { status: "active" } },
      ])

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
