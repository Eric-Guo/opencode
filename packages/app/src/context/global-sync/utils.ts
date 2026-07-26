import type { ModelInfo, ProviderV2Info } from "@opencode-ai/client/promise"
import type { Agent, Project, Provider } from "@opencode-ai/sdk/v2/client"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

export function normalizeAgentList(input: unknown): Agent[] {
  if (Array.isArray(input)) return input.filter(isAgent)
  if (isAgent(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(isAgent)
}

export function normalizeProviderList(input: {
  providers: ProviderV2Info[]
  models: ModelInfo[]
  defaultModel: ModelInfo | null
}): NormalizedProviderListResponse {
  const models = input.models
    .filter((model) => model.status !== "deprecated")
    .reduce<Map<string, ModelInfo[]>>((result, model) => {
      result.set(model.providerID, [...(result.get(model.providerID) ?? []), model])
      return result
    }, new Map())
  return {
    all: new Map(
      input.providers.map((provider) => [provider.id, normalizeProvider(provider, models.get(provider.id) ?? [])]),
    ),
    connected: input.providers.map((provider) => provider.id),
    default: input.defaultModel ? { [input.defaultModel.providerID]: input.defaultModel.id } : {},
  }
}

function normalizeProvider(provider: ProviderV2Info, models: ModelInfo[]): Provider {
  return {
    id: provider.id,
    name: provider.name,
    source: "api",
    env: [],
    options: provider.settings ?? {},
    models: Object.fromEntries(
      models.map((model) => {
        const cost = model.cost.find((item) => !item.tier) ?? model.cost[0]
        const input = new Set(model.capabilities.input)
        const output = new Set(model.capabilities.output)
        return [
          model.id,
          {
            id: model.id,
            providerID: model.providerID,
            api: {
              id: model.modelID,
              url: typeof model.settings?.baseURL === "string" ? model.settings.baseURL : "",
              npm: model.package ?? provider.package,
            },
            name: model.name,
            family: model.family,
            capabilities: {
              temperature: false,
              reasoning: model.variants.length > 0,
              attachment: [...input].some((item) => item !== "text"),
              toolcall: model.capabilities.tools,
              input: {
                text: input.has("text"),
                audio: input.has("audio"),
                image: input.has("image"),
                video: input.has("video"),
                pdf: input.has("pdf"),
              },
              output: {
                text: output.has("text"),
                audio: output.has("audio"),
                image: output.has("image"),
                video: output.has("video"),
                pdf: output.has("pdf"),
              },
              interleaved: false,
            },
            cost: {
              input: cost?.input ?? 0,
              output: cost?.output ?? 0,
              cache: cost?.cache ?? { read: 0, write: 0 },
              tiers: model.cost.flatMap((item) =>
                item.tier ? [{ input: item.input, output: item.output, cache: item.cache, tier: item.tier }] : [],
              ),
            },
            limit: model.limit,
            status: model.status,
            options: model.settings ?? {},
            headers: model.headers ?? {},
            release_date: model.time.released ? new Date(model.time.released).toISOString() : "",
            variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.settings ?? {}])),
          },
        ] as const
      }),
    ),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}
