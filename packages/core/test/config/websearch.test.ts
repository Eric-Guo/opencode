import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigWebSearchPlugin } from "@opencode/core/config/plugin/websearch"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { WebSearch } from "@opencode/core/websearch"
import { Document, Event, Info } from "@opencode/schema/config"
import { ConfigWebSearch } from "@opencode/schema/config/websearch"
import { Context, Effect, Layer } from "effect"
import path from "node:path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { emptyWellknownNode } from "../fixture/config-nodes"
import { tmpdir } from "../fixture/tmpdir"
import { Global } from "@opencode/util/global"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

describe("ConfigWebSearchPlugin.Plugin", () => {
  it.live("uses the saved user provider for the next query and reloads it from disk", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("websearch-preference-")))
      const user = path.join(tmp.path, "user")
      const defaults = path.join(tmp.path, "distribution")
      yield* Effect.promise(() =>
        Bun.write(path.join(defaults, "opencode.jsonc"), JSON.stringify({ websearch: { provider: "searchkimi" } })),
      )
      const options = { user, defaults, project: false, system: false }
      const load = () =>
        Layer.build(Config.layer(options)).pipe(
          Effect.provide(
            Layer.merge(Global.layerWith({ config: user, home: tmp.path }), AppNodeBuilder.build(emptyWellknownNode)),
          ),
        )
      const services = yield* load()
      const config = Context.get(services, Config.Service)
      const websearch = yield* WebSearch.Service
      const plugins = yield* Plugin.Service
      yield* websearch.transform((editor) => {
        editor.add({ id: WebSearch.ID.make("searchkimi"), name: "Kimi fixture", execute: () => Effect.succeed([]) })
        editor.add({ id: WebSearch.ID.make("exa"), name: "Exa fixture", execute: () => Effect.succeed([]) })
      })
      yield* ConfigWebSearchPlugin.Plugin.effect(yield* PluginHost.make(plugins)).pipe(Effect.provide(services))
      expect((yield* websearch.query({ query: "fixture before saving" })).providerID).toBe(
        WebSearch.ID.make("searchkimi"),
      )
      if (!config.update) return yield* Effect.die("Config.update is unavailable")
      yield* config.update({ websearch: new ConfigWebSearch.Info({ provider: WebSearch.ID.make("exa") }) }, "user")
      expect((yield* websearch.query({ query: "fixture after saving" })).providerID).toBe(WebSearch.ID.make("exa"))
      const reopened = yield* load()
      const restored = Context.get(reopened, Config.Service)
      expect(Config.latest(yield* restored.entries(), "websearch")).toEqual({
        provider: WebSearch.ID.make("exa"),
      })
    }),
  )
  it.live("reloads changed default selection", () =>
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      const bus = yield* Bus.Service
      const config = yield* Config.Test
      const plugins = yield* Plugin.Service
      yield* websearch.transform((editor) =>
        editor.add({ id: WebSearch.ID.make("test"), name: "Test", execute: () => Effect.succeed([]) }),
      )
      yield* ConfigWebSearchPlugin.Plugin.effect(yield* PluginHost.make(plugins))

      expect((yield* websearch.default().pipe(Effect.flip))._tag).toBe("WebSearch.Disabled")

      yield* config.setEntries([configured(new ConfigWebSearch.Info({ provider: "random" }))])
      yield* bus.publish(Event.Updated, {})
      yield* waitUntil(
        websearch.default().pipe(
          Effect.map((provider) => provider?.id === WebSearch.ID.make("test")),
          Effect.orElseSucceed(() => false),
        ),
      )
    }).pipe(Effect.provide(Config.testLayer([configured(false)]))),
  )
})

function configured(websearch: ConfigWebSearch.Selection): Document {
  return new Document({ type: "document", info: new Info({ websearch }) })
}

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  yield* Effect.die(new Error("Timed out waiting for websearch config reload"))
})
