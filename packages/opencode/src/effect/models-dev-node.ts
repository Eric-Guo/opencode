import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Flag } from "@/flag/flag"

const node = ModelsDev.configured({
  url: Flag.OPENCODE_MODELS_URL,
  file: Flag.OPENCODE_MODELS_PATH,
  fetch: !Flag.OPENCODE_DISABLE_MODELS_FETCH,
  bundledOnly: Flag.OPENCODE_MODELS_BUNDLED_ONLY,
})

export const ModelsDevNode = {
  node,
  replacement: [ModelsDev.node, node] as const,
}
