import { describe, expect, test } from "bun:test"
import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

const session = (id: string, parentID?: string): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/repo",
  title: id,
  version: "1",
  parentID,
  time: { created: 1, updated: 1 },
})

function setup(sessions: Record<string, Session>) {
  const get: unknown[] = []
  const messages: unknown[] = []
  const client = {
    session: {
      get: async (input: unknown) => {
        get.push(input)
        const id = (input as { sessionID: string }).sessionID
        return { data: sessions[id] }
      },
      messages: async (input: unknown) => {
        messages.push(input)
        return { data: [], response: { headers: new Headers() } }
      },
      diff: async () => ({ data: [] }),
      todo: async () => ({ data: [] }),
    },
  } as unknown as OpencodeClient
  return { get, messages, store: createServerSession(client) }
}

describe("server session", () => {
  test("resolves lineage by session ID without directory", async () => {
    const ctx = setup({ child: session("child", "root"), root: session("root") })

    const result = await ctx.store.lineage.resolve("child")

    expect(result.root.id).toBe("root")
    expect(ctx.get).toEqual([{ sessionID: "child" }, { sessionID: "root" }])
    expect(ctx.store.lineage.peek("child")).toEqual(result)
  })

  test("loads session content through the server client", async () => {
    const ctx = setup({ root: session("root") })

    await ctx.store.sync("root")

    expect(ctx.get).toEqual([{ sessionID: "root" }])
    expect(ctx.messages).toEqual([{ sessionID: "root", limit: 2, before: undefined }])
    expect(ctx.store.data.message.root).toEqual([])
  })

  test("merges live events into the initial page", async () => {
    let resolveMessages:
      | ((value: { data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }) => void)
      | undefined
    const user: Message = {
      id: "message-1",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const live: Message = {
      ...user,
      id: "message-2",
      time: { created: 2 },
    }
    const livePart: Part = {
      id: "part",
      sessionID: "child",
      messageID: live.id,
      type: "text",
      text: "live",
    }
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: () =>
          new Promise<{ data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }>((resolve) => {
            resolveMessages = resolve
          }),
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    const loading = store.sync("child")

    store.apply({ type: "message.updated", properties: { info: live } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: livePart, time: 2 } })
    resolveMessages?.({ data: [{ info: user, parts: [] }], response: { headers: new Headers() } })
    await loading

    expect(store.data.message.child).toEqual([user, live])
    expect(store.data.part[live.id]).toEqual([livePart])
  })

  test("preserves same-ID live updates over the initial page", async () => {
    let resolveMessages:
      | ((value: { data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }) => void)
      | undefined
    const fetched: Message = {
      id: "message",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const fetchedPart: Part = {
      id: "part",
      sessionID: "child",
      messageID: fetched.id,
      type: "text",
      text: "fetched",
    }
    const live = { ...fetched, time: { created: 2 } }
    const livePart = { ...fetchedPart, text: "live" }
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: () =>
          new Promise<{ data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }>((resolve) => {
            resolveMessages = resolve
          }),
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    const loading = store.sync("child")

    store.apply({ type: "message.updated", properties: { info: live } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: livePart, time: 2 } })
    resolveMessages?.({ data: [{ info: fetched, parts: [fetchedPart] }], response: { headers: new Headers() } })
    await loading

    expect(store.data.message.child).toEqual([live])
    expect(store.data.part[live.id]).toEqual([livePart])
  })

  test("preserves removals received during the initial load", async () => {
    let resolveMessages:
      | ((value: { data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }) => void)
      | undefined
    const removed: Message = {
      id: "message-1",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const kept = { ...removed, id: "message-2" }
    const part: Part = {
      id: "part",
      sessionID: "child",
      messageID: kept.id,
      type: "text",
      text: "removed",
    }
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: () =>
          new Promise<{ data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }>((resolve) => {
            resolveMessages = resolve
          }),
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    const loading = store.sync("child")

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: removed.id } })
    store.apply({
      type: "message.part.removed",
      properties: { sessionID: "child", messageID: kept.id, partID: part.id },
    })
    resolveMessages?.({
      data: [
        { info: removed, parts: [] },
        { info: kept, parts: [part] },
      ],
      response: { headers: new Headers() },
    })
    await loading

    expect(store.data.message.child).toEqual([kept])
    expect(store.data.part[kept.id]).toBeUndefined()
  })

  test("keeps removal tracking isolated across load generations", async () => {
    const resolveMessages: Array<
      (value: { data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }) => void
    > = []
    const message: Message = {
      id: "message",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: () =>
          new Promise<{ data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }>((resolve) => {
            resolveMessages.push(resolve)
          }),
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    const first = store.sync("child")
    store.apply({ type: "session.deleted", properties: { info: session("child", "root") } })
    const second = store.sync("child")

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    resolveMessages[0]?.({ data: [], response: { headers: new Headers() } })
    await first
    resolveMessages[1]?.({ data: [{ info: message, parts: [] }], response: { headers: new Headers() } })
    await second

    expect(store.data.message.child).toEqual([])
  })

  test("preserves remove then re-add during a refresh", async () => {
    let resolveRefresh:
      | ((value: { data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }) => void)
      | undefined
    const message: Message = {
      id: "message",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    let calls = 0
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: () => {
          calls += 1
          if (calls === 1)
            return Promise.resolve({ data: [{ info: message, parts: [] }], response: { headers: new Headers() } })
          return new Promise<{ data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }>((resolve) => {
            resolveRefresh = resolve
          })
        },
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    store.apply({ type: "message.updated", properties: { info: message } })
    resolveRefresh?.({ data: [], response: { headers: new Headers() } })
    await refreshing

    expect(store.data.message.child).toEqual([message])
  })

  test("does not restore removed optimistic content on refresh", async () => {
    const message: Message = {
      id: "message",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const part: Part = {
      id: "part",
      sessionID: "child",
      messageID: message.id,
      type: "text",
      text: "removed",
    }
    const kept = { ...message, id: "kept" }
    const keptPart = { ...part, id: "kept-part", messageID: kept.id }
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: async () => ({ data: [{ info: kept, parts: [] }], response: { headers: new Headers() } }),
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.optimistic.add({ sessionID: "child", message: kept, parts: [keptPart] })

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })
    store.apply({
      type: "message.part.removed",
      properties: { sessionID: "child", messageID: kept.id, partID: keptPart.id },
    })
    await store.sync("child", { force: true })

    expect(store.data.message.child).toEqual([kept])
    expect(store.data.part[message.id]).toBeUndefined()
    expect(store.data.part[kept.id]).toBeUndefined()
  })

  test("replaces confirmed optimistic content with the initial page", async () => {
    const optimistic: Message = {
      id: "message",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const fetched = { ...optimistic, time: { created: 2 } }
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: async () => ({ data: [{ info: fetched, parts: [] }], response: { headers: new Headers() } }),
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    store.optimistic.add({ sessionID: "child", message: optimistic, parts: [] })

    await store.sync("child")

    expect(store.data.message.child).toEqual([fetched])
  })

  test("clears stale parts when the initial page has none", async () => {
    let resolveMessages:
      | ((value: { data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }) => void)
      | undefined
    const message: Message = {
      id: "message",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const part: Part = {
      id: "part",
      sessionID: "child",
      messageID: message.id,
      type: "text",
      text: "stale",
    }
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: () =>
          new Promise<{ data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }>((resolve) => {
            resolveMessages = resolve
          }),
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    store.apply({ type: "message.updated", properties: { info: message } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 1 } })
    const loading = store.sync("child")

    resolveMessages?.({ data: [{ info: message, parts: [] }], response: { headers: new Headers() } })
    await loading

    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("clears delta buffers for parts omitted by the initial page", async () => {
    let resolveMessages:
      | ((value: { data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }) => void)
      | undefined
    const message: Message = {
      id: "message",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const kept: Part = { id: "part-1", sessionID: "child", messageID: message.id, type: "text", text: "kept" }
    const removed: Part = { ...kept, id: "part-2", text: "removed" }
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: () =>
          new Promise<{ data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }>((resolve) => {
            resolveMessages = resolve
          }),
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    store.apply({ type: "message.updated", properties: { info: message } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: kept, time: 1 } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part: removed, time: 1 } })
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: removed.id, field: "text", delta: " delta" },
    })
    const loading = store.sync("child")

    resolveMessages?.({ data: [{ info: message, parts: [kept] }], response: { headers: new Headers() } })
    await loading

    expect(store.data.part[message.id]).toEqual([kept])
    expect(store.data.part_text_accum_delta[removed.id]).toBeUndefined()
  })

  test("preserves live updates during a forced refresh", async () => {
    let resolveRefresh:
      | ((value: { data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }) => void)
      | undefined
    const stale: Message = {
      id: "message",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const stalePart: Part = {
      id: "part",
      sessionID: "child",
      messageID: stale.id,
      type: "text",
      text: "stale",
    }
    let calls = 0
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: () => {
          calls += 1
          if (calls === 1)
            return Promise.resolve({ data: [{ info: stale, parts: [stalePart] }], response: { headers: new Headers() } })
          return new Promise<{ data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }>((resolve) => {
            resolveRefresh = resolve
          })
        },
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    await store.sync("child")
    const refreshing = store.sync("child", { force: true })
    const live = { ...stale, time: { created: 2 } }
    const livePart = { ...stalePart, text: "live" }

    store.apply({ type: "message.updated", properties: { info: live } })
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: stale.id, partID: stalePart.id, field: "text", delta: " live" },
    })
    resolveRefresh?.({ data: [{ info: stale, parts: [stalePart] }], response: { headers: new Headers() } })
    await refreshing

    expect(store.data.message.child).toEqual([live])
    expect(store.data.part[stale.id]).toEqual([{ ...livePart, text: "stale live" }])
  })

  test("preserves removals during history prepend", async () => {
    let resolveHistory:
      | ((value: { data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }) => void)
      | undefined
    const latest: Message = {
      id: "message-2",
      sessionID: "child",
      role: "user",
      time: { created: 2 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const older = { ...latest, id: "message-1", time: { created: 1 } }
    let calls = 0
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: () => {
          calls += 1
          if (calls === 1)
            return Promise.resolve({
              data: [{ info: latest, parts: [] }],
              response: { headers: new Headers({ "x-next-cursor": "older" }) },
            })
          return new Promise<{ data: { info: Message; parts: Part[] }[]; response: { headers: Headers } }>((resolve) => {
            resolveHistory = resolve
          })
        },
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    await store.sync("child")
    const loading = store.history.loadMore("child")

    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: older.id } })
    resolveHistory?.({ data: [{ info: older, parts: [] }], response: { headers: new Headers() } })
    await loading

    expect(store.data.message.child).toEqual([latest])
  })

  test("clears orphaned parts when a refresh drops a message", async () => {
    const message: Message = {
      id: "message",
      sessionID: "child",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const part: Part = {
      id: "part",
      sessionID: "child",
      messageID: message.id,
      type: "text",
      text: "stale",
    }
    let calls = 0
    const client = {
      session: {
        get: async () => ({ data: session("child", "root") }),
        messages: async () => {
          calls += 1
          return {
            data: calls === 1 ? [{ info: message, parts: [part] }] : [],
            response: { headers: new Headers() },
          }
        },
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)
    await store.sync("child")
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: " delta" },
    })
    await store.sync("child", { force: true })

    expect(store.data.message.child).toEqual([])
    expect(store.data.part[message.id]).toBeUndefined()
    expect(store.data.part_text_accum_delta[part.id]).toBeUndefined()
  })

  test("applies events without a directory store", () => {
    const ctx = setup({})
    ctx.store.apply({ type: "session.created", properties: { info: session("root") } })
    ctx.store.apply({ type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } })

    expect(ctx.store.get("root")?.directory).toBe("/repo")
    expect(ctx.store.data.session_working("root")).toBe(true)
  })

  test("preserves pinned session content under server-wide cache pressure", () => {
    const ctx = setup({})
    ctx.store.pin("active")
    ctx.store.optimistic.add({
      sessionID: "active",
      message: {
        id: "message",
        sessionID: "active",
        role: "assistant",
        time: { created: 1 },
        parentID: "parent",
        modelID: "model",
        providerID: "provider",
        mode: "build",
        agent: "agent",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    })

    for (let index = 0; index < 50; index++) {
      ctx.store.apply({
        type: "session.status",
        properties: { sessionID: `session-${index}`, status: { type: "busy" } },
      })
    }

    expect(ctx.store.data.message.active?.map((message) => message.id)).toEqual(["message"])
  })
})
