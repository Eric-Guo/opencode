import { LLMClient, RequestExecutor } from "@opencode-ai/ai/route"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { filesystem, httpClient, path } from "@opencode-ai/util/effect/app-node-platform"

export { filesystem, httpClient, path }

export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer,
  deps: [httpClient],
})

export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export * as LayerNodePlatform from "./app-node-platform"
