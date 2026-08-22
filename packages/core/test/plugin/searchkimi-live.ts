import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Credential } from "@opencode-ai/core/credential"
import { Config } from "@opencode-ai/core/config"
import { Bus } from "@opencode-ai/core/bus"
import { Form } from "@opencode-ai/core/form"
import { Image } from "@opencode-ai/core/image"
import { Integration } from "@opencode-ai/core/integration"
import { Permission } from "@opencode-ai/core/permission"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool"
import { WebSearch } from "@opencode-ai/core/websearch"
import { WebSearchTool } from "@opencode-ai/core/tool/plugin/websearch"
import { SearchKimi } from "@opencode-ai/core/plugin/websearch/searchkimi"
import { host, integrationHost, webSearchHost } from "./host"
import { imagePassthrough } from "../lib/image"
import { permissionLayer } from "../lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "../lib/tool"
import { readFileSync } from "node:fs"

const toml = readFileSync(`${process.env.HOME}/.kimi-code/config.toml`, "utf8")
const section = toml.split("[services.moonshot_search]")[1]!
const apiKey = section.match(/api_key\s*=\s*"([^"]+)"/)![1]

const webSearchToolNode = makeLocationNode({
  name: "test/websearch-tool-plugin",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      yield* registerToolPlugin(WebSearchTool.Plugin, { websearch: webSearchHost(websearch) })
    }),
  ),
  deps: [Tool.node, Permission.node, WebSearch.node, Form.node],
})

const layer = Layer.mergeAll(
  AppNodeBuilder.build(
    LayerNode.group([Integration.node, Credential.node, Bus.node, Form.node, WebSearch.node, Tool.node, webSearchToolNode]),
    [
      Config.node.replace(Config.testLayer()),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      Image.node.replace(imagePassthrough),
    ],
  ),
  FetchHttpClient.layer,
)

const program = Effect.gen(function* () {
  const integrations = yield* Integration.Service
  const websearch = yield* WebSearch.Service
  yield* SearchKimi.Plugin.effect(
    host({ integration: integrationHost(integrations), websearch: webSearchHost(websearch) }),
  )
  yield* integrations.connection.key({
    integrationID: Integration.ID.make("searchkimi"),
    key: apiKey,
  })
  yield* websearch.select(WebSearch.ID.make("searchkimi"))

  const registry = yield* Tool.Service
  const result = yield* executeTool(registry, {
    sessionID: Session.ID.make("ses_searchkimi_live"),
    ...toolIdentity,
    call: { type: "tool-call", id: "call-live", name: "websearch", input: { query: "过纯中" } },
  })
  console.log("STATUS:", result.status)
  if (result.error) console.log("ERROR:", JSON.stringify(result.error))
  console.log("CONTENT:", JSON.stringify(result.content)?.slice(0, 3000))
  console.log("HAS [object Object]:", JSON.stringify(result).includes("[object Object]"))
})

Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer))).catch((error) => {
  console.error("FAILED:", error)
  process.exit(1)
})
