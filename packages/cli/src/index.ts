#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Commands } from "./commands/commands"
import { Runtime } from "./framework/runtime"
import { Observability } from "@opencode-ai/util/observability"
import { Updater } from "./services/updater"
import { Installation } from "@opencode-ai/core/installation"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { AppProcess } from "@opencode-ai/util/process"
import { Config } from "./config"
import { Npm } from "@opencode-ai/util/npm"
import { Heap } from "./heap"
import { ensureSsoUsername } from "@opencode-ai/core/thape-sso"
import { configDirectory } from "./config-directory"

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  acp: () => import("./commands/handlers/acp"),
  api: () => import("./commands/handlers/api"),
  auth: {
    login: () => import("./commands/handlers/auth/login"),
  },
  debug: {
    agent: () => import("./commands/handlers/debug/agent"),
    agents: () => import("./commands/handlers/debug/agents"),
    config: () => import("./commands/handlers/debug/config"),
  },
  console: {
    login: () => import("./commands/handlers/console/login"),
  },
  mcp: {
    list: () => import("./commands/handlers/mcp/list"),
    add: () => import("./commands/handlers/mcp/add"),
    auth: () => import("./commands/handlers/mcp/auth"),
    logout: () => import("./commands/handlers/mcp/logout"),
  },
  plugin: {
    list: () => import("./commands/handlers/plugin/list"),
  },
  models: () => import("./commands/handlers/models"),
  export: () => import("./commands/handlers/export"),
  import: () => import("./commands/handlers/import"),
  mini: () => import("./commands/handlers/mini"),
  run: () => import("./commands/handlers/run"),
  pair: () => import("./commands/handlers/pair"),
  service: {
    start: () => import("./commands/handlers/service/start"),
    restart: () => import("./commands/handlers/service/restart"),
    status: () => import("./commands/handlers/service/status"),
    stop: () => import("./commands/handlers/service/stop"),
    get: () => import("./commands/handlers/service/get"),
    set: () => import("./commands/handlers/service/set"),
    unset: () => import("./commands/handlers/service/unset"),
  },
  serve: () => import("./commands/handlers/serve"),
})

Effect.gen(function* () {
  yield* Heap.listen
  yield* Effect.promise(() => ensureSsoUsername())
  yield* Effect.logInfo("cli starting", {
    version: Installation.version,
    channel: Installation.channel,
    local: Installation.local,
    args: process.argv.slice(2),
  })
  return yield* Runtime.run(Commands, Handlers, { version: Installation.version })
}).pipe(
  Effect.annotateLogs({ role: "cli" }),
  Effect.provide(Config.layer),
  Effect.provide(Updater.layer),
  Effect.provide(
    LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node]), [
      [Global.node, Global.layerWith({ config: configDirectory() })],
    ]),
  ),
  Effect.provide(
    Observability.layer({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      client: process.env.OPENCODE_CLIENT ?? "cli",
      version: Installation.version,
      channel: Installation.channel,
    }),
  ),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
)
