import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { OpenCodeClient } from "@opencode-ai/client/promise"
import type { Config, OpencodeClient, Project, Session } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { bootstrapDirectory, loadPathQuery, loadProvidersQuery } from "./bootstrap"
import type { State, VcsCache } from "./types"
import { createServerSession } from "../server-session"
import { ServerScope } from "@/utils/server-scope"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

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
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: {
          reference: { list: async () => ({ data: { data: [] } }) },
          model: {
            default: async () => ({ data: { data: null } }),
            list: async () => ({ data: { data: [] } }),
          },
          provider: { list: async () => ({ data: { data: [] } }) },
        },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
      } as unknown as OpencodeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })

  test("seeds session status even while warming session info stalls", async () => {
    const [store, setStore] = directoryState()
    const stalled = Promise.withResolvers<never>()
    const client = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        status: async () => ({ data: { ses_busy: { type: "busy" } } }),
        get: () => stalled.promise,
      },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      v2: {
        reference: { list: async () => ({ data: { data: [] } }) },
        model: {
          default: async () => ({ data: { data: null } }),
          list: async () => ({ data: { data: [] } }),
        },
        provider: { list: async () => ({ data: { data: [] } }) },
      },
      mcp: { status: async () => ({ data: {} }) },
    } as unknown as OpencodeClient
    const session = createServerSession(client)
    const stale: Session = {
      id: "ses_stale",
      slug: "ses_stale",
      projectID: "project",
      directory: "/project",
      title: "stale",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    session.remember(stale)
    session.set("session_status", stale.id, { type: "busy" })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
    })

    const deadline = Date.now() + 500
    while (!session.data.session_working("ses_busy") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(session.data.session_status["ses_busy"]?.type).toBe("busy")
    expect(session.data.session_status[stale.id]).toBeUndefined()
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as OpencodeClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })

  test("loads the provider catalog from V2 after model initialization", async () => {
    const calls: string[] = []
    const model = {
      id: "claude-sonnet",
      modelID: "claude-sonnet-4",
      providerID: "anthropic",
      name: "Claude Sonnet",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [{ id: "high", settings: { effort: "high" } }],
      time: { released: Date.parse("2026-01-02") },
      cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      status: "active",
      enabled: true,
      limit: { context: 200_000, output: 64_000 },
    }
    const catalog = {
      model: {
        default: async () => {
          calls.push("default")
          return { data: model }
        },
        list: async () => {
          calls.push("models")
          return { data: [model] }
        },
      },
      provider: {
        list: async () => {
          calls.push("providers")
          return { data: [{ id: "anthropic", name: "Anthropic", package: "@ai-sdk/anthropic" }] }
        },
      },
    } as unknown as Pick<OpenCodeClient, "model" | "provider">

    const result = await new QueryClient().fetchQuery(
      loadProvidersQuery(ServerScope.local, "/repo", {} as OpencodeClient, catalog),
    )

    expect(calls[0]).toBe("default")
    expect(new Set(calls.slice(1))).toEqual(new Set(["providers", "models"]))
    expect(result.connected).toEqual(["anthropic"])
    expect(result.default).toEqual({ anthropic: "claude-sonnet" })
    expect(result.all.get("anthropic")?.models["claude-sonnet"]).toMatchObject({
      id: "claude-sonnet",
      api: { id: "claude-sonnet-4", npm: "@ai-sdk/anthropic" },
      capabilities: { attachment: true, toolcall: true, reasoning: true },
      variants: { high: { effort: "high" } },
    })
  })
})
