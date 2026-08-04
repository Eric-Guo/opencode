import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { CancelledError, QueryClient } from "@tanstack/solid-query"
import type { Config, Project } from "@/types"
import type { AgentApi, CatalogApi, CommandApi, ReferenceApi } from "@opencode-ai/client/promise"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import {
  bootstrapDirectory,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./bootstrap"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"
import type { ServerApi } from "@/utils/server"

type ProjectApi = ServerApi["project"]
type WorktreeApi = ServerApi["worktree"]

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
const bootstrapApi = {
  agent: { list: async () => ({ location: {}, data: [] }) },
  provider: { list: async () => ({ location: {}, data: [] }) },
  model: {
    list: async () => ({ location: {}, data: [] }),
    default: async () => ({ location: {}, data: null }),
  },
  permission: { request: { list: async () => ({ location: {}, data: [] }) } },
  project: {
    list: async () => [],
    current: async () => ({ id: "project", directory: "/project" }),
  },
  question: { request: { list: async () => ({ location: {}, data: [] }) } },
  reference: { list: async () => ({ location: {}, data: [] }) },
} as unknown as ServerApi

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

const bootstrapInput = () => {
  const [store, setStore] = directoryState()
  return {
    directory: "/project",
    scope: ServerScope.local,
    mcp: false,
    global: {
      config: {} satisfies Config,
      path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
      project: [{ id: "project", worktree: "/project" } as Project],
      provider,
    },
    api: bootstrapApi,
    store,
    setStore,
    vcsCache: { setStore() {} } as unknown as VcsCache,
    translate: (key: string) => key,
    queryClient: new QueryClient(),
  }
}

describe("bootstrapDirectory", () => {
  test("waits for all directory reads before resolving", async () => {
    const refresh = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const input = bootstrapInput()
    let sessionReads = 0

    const pending = bootstrapDirectory({
      ...input,
      loadSessions() {
        sessionReads++
        started.resolve()
        return refresh.promise
      },
    })
    let resolved = false
    void pending.then(() => {
      resolved = true
    })

    await started.promise

    expect(resolved).toBe(false)
    expect(input.store.status).toBe("partial")

    refresh.resolve()
    await pending

    expect(resolved).toBe(true)
    expect(sessionReads).toBe(2)
    expect(input.store.status).toBe("complete")
  })

  test("treats superseded query reads as successful refreshes", async () => {
    const input = bootstrapInput()

    await bootstrapDirectory({
      ...input,
      loadSessions: () => Promise.reject(new CancelledError()),
    })

    expect(input.store.status).toBe("complete")
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const api = {} as CatalogApi
    const location = {} as ServerApi["location"]
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", location).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", location).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, api).queryKey]).toEqual(["https://debian.example", null, "providers"])
  })

  test("loads the global config required by v2 desktop clients", async () => {
    const configReads: string[] = []
    const api = {
      global: async () => {
        configReads.push("config")
        return { shell: "bash" }
      },
    } as unknown as ServerApi["config"]

    const result = await new QueryClient().fetchQuery(loadGlobalConfigQuery(ServerScope.local, api))

    expect(result).toEqual({ shell: "bash" })
    expect(configReads).toEqual(["config"])
  })

  test("loads the current provider and model catalog", async () => {
    const calls: unknown[] = []
    let ready = false
    const api = {
      provider: {
        list: async (input: unknown) => {
          calls.push(["provider", input])
          return {
            location: {},
            data: ready ? [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai" }] : [],
          }
        },
      },
      model: {
        list: async (input: unknown) => {
          calls.push(["model", input])
          return { location: {}, data: [] }
        },
        default: async (input: unknown) => {
          calls.push(["default", input])
          ready = true
          return { location: {}, data: null }
        },
      },
    } as unknown as CatalogApi

    const result = await new QueryClient().fetchQuery(loadProvidersQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([
      ["default", { location: { directory: "/repo" } }],
      ["provider", { location: { directory: "/repo" } }],
      ["model", { location: { directory: "/repo" } }],
    ])
    expect(result.connected).toEqual(["openai"])
  })

  test("loads current location metadata", async () => {
    const calls: unknown[] = []
    const api = {
      get: async (input: unknown) => {
        calls.push(input)
        return { directory: "/repo/subpath", project: { id: "project", directory: "/repo" } }
      },
    } as ServerApi["location"]

    const result = await new QueryClient().fetchQuery(loadPathQuery(ServerScope.local, "/repo/subpath", api))

    expect(calls).toEqual([{ location: { directory: "/repo/subpath" } }])
    expect(result).toMatchObject({ directory: "/repo/subpath", worktree: "/repo" })
  })

  test("loads agents from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [] }
      },
    } as unknown as AgentApi

    const result = await new QueryClient().fetchQuery(loadAgentsQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([])
  })

  test("loads commands from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return {
          location: {},
          data: [{ name: "review", template: "Review files" /* source: "command" as const */ }],
        }
      },
    } as unknown as CommandApi

    const result = await loadCommands("/repo", api)

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([{ name: "review", template: "Review files" /* source: "command" */ }])
  })

  test("loads projects from the current endpoint", async () => {
    const calls: string[] = []
    const projects = {
      list: async () => [
        { id: "b", canonical: "/b", time: { created: 1, updated: 1 }, sandboxes: [] },
        { id: "a", canonical: "/a", time: { created: 1, updated: 1 }, sandboxes: [] },
      ],
    } as unknown as ProjectApi
    const worktrees = {
      list: async ({ projectID }: { projectID: string }) => {
        calls.push(projectID)
        return [
          { directory: `/${projectID}` },
          { directory: `/${projectID}/clone` },
          { directory: `/${projectID}/copy`, strategy: "git" },
        ]
      },
    } as unknown as WorktreeApi

    const result = await new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, projects, worktrees))

    expect(result.map((project) => project.id)).toEqual(["a", "b"])
    expect(result.map((project) => project.sandboxes)).toEqual([
      ["/a/clone", "/a/copy"],
      ["/b/clone", "/b/copy"],
    ])
    expect(result.map((project) => project.worktrees)).toEqual([
      [{ directory: "/a" }, { directory: "/a/clone" }, { directory: "/a/copy", strategy: "git" }],
      [{ directory: "/b" }, { directory: "/b/clone" }, { directory: "/b/copy", strategy: "git" }],
    ])
    expect(calls.toSorted()).toEqual(["a", "b"])
  })

  test("keeps projects whose directory inventory cannot load", async () => {
    const projects = {
      list: async () => [
        { id: "a", canonical: "/a", time: { created: 1, updated: 1 }, sandboxes: [] },
        { id: "b", canonical: "/b", time: { created: 1, updated: 1 }, sandboxes: [] },
      ],
    } as unknown as ProjectApi
    const worktrees = {
      list: async ({ projectID }: { projectID: string }) => {
        if (projectID === "b") throw new Error("unavailable")
        return [{ directory: "/a/copy", strategy: "git" as const }]
      },
    } as unknown as WorktreeApi

    const result = await new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, projects, worktrees))

    expect(result.map((project) => ({ id: project.id, sandboxes: project.sandboxes }))).toEqual([
      { id: "a", sandboxes: ["/a/copy"] },
      { id: "b", sandboxes: [] },
    ])
  })

  test("loads references from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [{ name: "AGENTS.md", path: "/repo/AGENTS.md", source: "instructions" }] }
      },
    } as unknown as ReferenceApi

    const result = await new QueryClient().fetchQuery(loadReferencesQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toHaveLength(1)
  })
})
