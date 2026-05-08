import { createStore } from "solid-js/store"

const provider = {
  all: [
    {
      id: "anthropic",
      models: {
        "claude-3-7-sonnet": {
          id: "claude-3-7-sonnet",
          name: "Claude 3.7 Sonnet",
          cost: { input: 1, output: 1 },
        },
      },
    },
  ],
  connected: ["anthropic"],
  default: { anthropic: "claude-3-7-sonnet" },
}

const [store, setStore] = createStore({
  provider,
  session: [] as any[],
  config: { permission: {} },
})

export function useServerSync() {
  return {
    data: {
      provider,
    },
    child() {
      return [store, setStore] as const
    },
    queryOptions: useQueryOptions(),
  }
}

export function useQueryOptions() {
  return {
    globalConfig: () => ({ queryKey: ["globalConfig"] }),
    projects: () => ({ queryKey: ["projects"] }),
    providers: (directory: string | null) => ({
      queryKey: [directory, "providers"],
      queryFn: async () => provider,
    }),
    path: (_directory: any) => ({ queryKey: ["path"] }),
    agents: (directory: string) => ({
      queryKey: [directory, "agents"],
      queryFn: async () => [],
    }),
    mcp: (_directory: any) => ({ queryKey: ["mcp"] }),
    lsp: (_directory: any) => ({ queryKey: ["lsp"] }),
    sessions: (_directory: any) => ({ queryKey: ["sessions"] }),
  }
}
