import { expect } from "bun:test"
import { join } from "node:path"
import { Context, Deferred, Effect, Fiber, Result, Stream, type Schema } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { Rpc } from "@opencode/core/rpc"
import { Session } from "@opencode/core/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Browser } from "../../plugin-browser/src/rpc"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { offlineModels } from "../../core/test/fixture/models"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { builtinExtensions } from "../src/builtins"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"
import { hostTools } from "../src/host"
import { packageTools } from "../src/package-tools"
import { Packages } from "../src/packages"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Session.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
  ]),
)

it.live("Nexus lists and uses the configured session's desktop Browser without managed packages", () =>
  Effect.gen(function* () {
    const directory = AbsolutePath.make((yield* tmpdirScoped()).path)
    const location = Location.Ref.make({ directory })
    const locations = yield* LocationServiceMap.Service
    const services = yield* locations.contextEffect(location)
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ location })

    yield* Plugin.awaitActivation.pipe(Effect.provideContext(services))

    const host = hostTools(locations, sessions)
    const browser = yield* Effect.tryPromise((signal) => host.desktopBrowser(session.id, signal))
    const open = Effect.tryPromise((signal) => browser("tabs_open", {}, signal))

    expect(Result.isFailure(yield* Effect.result(open))).toBe(true)

    const rpc = Context.get(services, Rpc.Service).client(Browser.Definition)
    const attachment = { sessionID: session.id, connectionID: "desktop-fixture" }
    const attached = yield* Deferred.make<void>()
    const tab: Browser.Tab = {
      id: Browser.TabID.make("tab_1b244f1b-2925-4c31-9885-4c66bd20254e"),
      title: "",
      url: "about:blank",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      generation: 0,
    }
    const operations: Browser.Action[] = []

    yield* rpc.events.subscribe("control").pipe(
      Stream.filter((event) => event.data.connectionID === attachment.connectionID),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.data.type === "attached") return yield* Deferred.succeed(attached, undefined)
          if (event.data.type !== "command") return

          const request = { ...attachment, requestID: event.data.requestID }
          const { action } = yield* rpc.command(request)
          operations.push(action)

          if (action.type === "tabs.open" || action.type === "tabs.close")
            yield* rpc.state({
              ...attachment,
              state:
                action.type === "tabs.open" ? { tabs: [tab], focusedTabID: tab.id } : { tabs: [], focusedTabID: null },
            })

          const value: Schema.Json =
            action.type === "snapshot"
              ? { tab, content: "OpenCode desktop fixture", truncated: false }
              : action.type === "tabs.close"
                ? { tabs: [], focusedTabID: null }
                : tab

          yield* rpc.result({ ...request, outcome: { type: "success", result: { value, files: [] } } })
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    const connection = yield* rpc.attach({ ...attachment, version: 4 }).pipe(Effect.forkScoped)
    yield* Deferred.await(attached)

    const configuration = new Configuration(join(directory, "nexus-configuration.json"))
    const packages = new Packages(directory, configuration)
    const extension = (yield* Effect.promise(() => builtinExtensions(host))).find(
      (module) => module.descriptor.id === "nexus.browser",
    )!
    const published = Promise.withResolvers<void>()
    const manager: ExtensionManager = new ExtensionManager(
      configuration,
      [packageTools(packages, () => manager), extension],
      directory,
      new AbortController().signal,
      async () => published.resolve(),
    )
    const context = { workspace: "workspace", conversation: "conversation", run: "run", task: "task", directory }

    yield* Effect.addFinalizer(() => Effect.promise(() => manager.close()))
    yield* Effect.tryPromise(() =>
      configuration.replace(extension.descriptor, {
        enabled: false,
        configuration: { backend: "desktop", executable: "", desktop_session: session.id },
      }),
    )
    yield* Effect.tryPromise(() => manager.start())

    const list = manager.tools().find((tool) => tool.definition.name === "list_extensions")!
    const inventory = Effect.tryPromise(async (signal) => {
      const result = await list.execute({}, { ...context, signal })

      return JSON.parse(String(result.content))
    })

    expect(yield* inventory).toMatchObject({
      packages: [],
      extensions: expect.arrayContaining([
        expect.objectContaining({ id: "nexus.browser", enabled: false, active: false, tools: [] }),
      ]),
    })

    yield* Effect.tryPromise(() => manager.change({ id: "nexus.browser", enabled: true }))
    yield* Effect.promise(() => published.promise)

    const result = yield* inventory
    expect(result).toMatchObject({
      packages: [],
      extensions: expect.arrayContaining([
        expect.objectContaining({
          id: "nexus.browser",
          enabled: true,
          active: true,
          ready: true,
          restart_required: false,
          tools: expect.arrayContaining(["browser_navigate"]),
        }),
      ]),
    })
    expect(JSON.stringify(result)).not.toContain(session.id)

    const navigate = manager.tools().find((tool) => tool.definition.name === "browser_navigate")!
    const navigation = yield* Effect.tryPromise((signal) =>
      navigate.execute({ url: "https://example.test/" }, { ...context, signal }),
    )

    expect(navigation.content).toContain("OpenCode desktop fixture")
    yield* Effect.promise(() => manager.close())
    expect(operations).toEqual([
      { type: "tabs.open" },
      { type: "navigate", tabID: tab.id, url: "https://example.test/" },
      { type: "snapshot", tabID: tab.id },
      { type: "tabs.close", tabID: tab.id },
    ])

    yield* Fiber.interrupt(connection)
    expect(Result.isFailure(yield* Effect.result(open))).toBe(true)
  }),
)
