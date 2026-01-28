import { describe, expect, test } from "bun:test"
import type { Config, OpencodeClient, Path, Project, ProviderAuthResponse, ProviderListResponse, Todo } from "@opencode-ai/sdk/v2/client"
import { QueryClient } from "@tanstack/solid-query"
import { createStore } from "solid-js/store"
import { bootstrapGlobal } from "./global-sync/bootstrap"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"

type TestGlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  session_todo: Record<string, Todo[]>
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

const globalStore = () =>
  createStore<TestGlobalStore>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    project: [],
    session_todo: {},
    provider: { all: [], connected: [], default: {} } as ProviderListResponse,
    provider_auth: {} as ProviderAuthResponse,
    config: {},
    reload: undefined as undefined | "pending" | "complete",
  })

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10 }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25 },
      { directory: "dir", roots: true },
    ])
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})

describe("bootstrapGlobal", () => {
  test("sets ready before provider auth prefetch resolves", async () => {
    const [store, setStore] = globalStore()
    const queryClient = new QueryClient()
    let authCalls = 0
    let resolveAuth: ((value: { data: ProviderAuthResponse }) => void) | undefined
    const auth = new Promise<{ data: ProviderAuthResponse }>((resolve) => {
      resolveAuth = resolve
    })
    const sdk = {
      global: {
        health: async () => ({ data: { healthy: true } }),
        config: {
          get: async () => ({ data: {} }),
        },
      },
      provider: {
        list: async () => ({ data: { all: [], connected: [], default: {} } }),
        auth: async () => {
          authCalls += 1
          return auth
        },
      },
      path: {
        get: async () => ({
          data: { state: "", config: "", worktree: "", directory: "", home: "" },
        }),
      },
      project: {
        list: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient

    await bootstrapGlobal({
      globalSDK: sdk,
      connectErrorTitle: "connect",
      connectErrorDescription: "connect failed",
      requestFailedTitle: "request failed",
      translate: (key) => key,
      formatMoreCount: (count) => `${count}`,
      scheduleRetry() {},
      notice: { health: false, config: false },
      setGlobalStore: setStore,
      queryClient,
    })

    expect(store.ready).toBe(true)
    expect(authCalls).toBe(1)
    expect(store.provider_auth).toEqual({})

    resolveAuth?.({ data: { github: [] } })
    await auth
    await Promise.resolve()

    expect(store.provider_auth).toEqual({ github: [] })
  })

  test("delegates bootstrap retries through scheduleRetry", async () => {
    const [store, setStore] = globalStore()
    const queryClient = new QueryClient()
    let retries = 0
    const sdk = {
      global: {
        health: async () => ({ data: { healthy: false } }),
        config: {
          get: async () => ({ data: {} }),
        },
      },
      provider: {
        list: async () => ({ data: { all: [], connected: [], default: {} } }),
        auth: async () => ({ data: {} }),
      },
      path: {
        get: async () => ({
          data: { state: "", config: "", worktree: "", directory: "", home: "" },
        }),
      },
      project: {
        list: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient

    await bootstrapGlobal({
      globalSDK: sdk,
      connectErrorTitle: "connect",
      connectErrorDescription: "connect failed",
      requestFailedTitle: "request failed",
      translate: (key) => key,
      formatMoreCount: (count) => `${count}`,
      scheduleRetry() {
        retries += 1
      },
      notice: { health: false, config: false },
      setGlobalStore: setStore,
      queryClient,
    })

    expect(retries).toBe(1)
    expect(store.ready).toBe(false)
  })
})
