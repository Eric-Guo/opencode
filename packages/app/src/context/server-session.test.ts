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
