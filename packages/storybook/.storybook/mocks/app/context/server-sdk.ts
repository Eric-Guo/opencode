import type { IntegrationMethod } from "@opencode-ai/client/promise"

const providers = [
  "opencode",
  "opencode-go",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "vercel",
  "github-copilot",
  "302ai",
  "abacus",
  "abliteration",
  "alibaba",
  "alibaba-cn",
  "alibaba-coding-plan",
]

const integrationMethods = Object.fromEntries(
  providers.map((provider) => [provider, [{ type: "key" as const, label: "API key" }]]),
) as Record<string, IntegrationMethod[]>

export function mockIntegrationMethods(provider: string, methods: IntegrationMethod[]) {
  const previous = integrationMethods[provider]
  integrationMethods[provider] = methods
  return () => {
    if (previous) {
      integrationMethods[provider] = previous
      return
    }
    delete integrationMethods[provider]
  }
}

const client = {
  provider: {
    auth: async () => ({
      data: Object.fromEntries(providers.map((provider) => [provider, [{ type: "api", label: "API key" }]])),
    }),
    oauth: {
      authorize: async (input: { method?: number }) => ({
        data: {
          url: "https://example.com/oauth",
          method: input.method === 1 ? ("code" as const) : ("auto" as const),
          instructions: input.method === 1 ? "Paste the authorization code" : "Confirmation code: ABCD-EFGH",
        },
      }),
      callback: async (input: { method?: number }) => {
        if (input.method === 0) return new Promise<never>(() => {})
        return { data: undefined }
      },
    },
  },
  auth: {
    set: async () => ({ data: true }),
  },
  global: {
    dispose: async () => ({ data: true }),
  },
}

const api = {
  integration: {
    get: async (input: { integrationID: string }) => ({
      data: {
        id: input.integrationID,
        name: input.integrationID,
        methods: integrationMethods[input.integrationID] ?? [],
        connections: [],
      },
    }),
    connect: {
      key: async () => {},
    },
    oauth: {
      connect: async (input: { integrationID: string; methodID: string }) => ({
        data: {
          attemptID: `${input.integrationID}:${input.methodID}`,
          url: "https://example.com/oauth",
          instructions: input.methodID === "1" ? "Paste the authorization code" : "Confirmation code: ABCD-EFGH",
          mode: input.methodID === "1" ? ("code" as const) : ("auto" as const),
          time: { created: Date.now(), expires: Date.now() + 10 * 60 * 1000 },
        },
      }),
      complete: async () => {},
      status: async () => ({
        data: {
          status: "complete" as const,
          time: { created: Date.now(), expires: Date.now() },
        },
      }),
    },
  },
}

export function useServerSDK() {
  return () => ({ api, client })
}
