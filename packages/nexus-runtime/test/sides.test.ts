import { expect, test } from "bun:test"
import { Client, type JsonObject, type StoreEntry } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { sideLeads } from "../src/sides"
import { conversationFixture, inputFixture } from "./fixture/conversation"

function fixture() {
  const stores = new Map<string, Map<string, StoreEntry>>()
  const conversations = new Map<string, JsonObject>([
    [
      "parent",
      conversationFixture({
        public_id: "parent",
        default_runner: { executor_public_id: "runner", presence: "online" },
      }),
    ],
  ])
  const receipts = new Map<string, JsonObject>()
  const forkKeys: string[] = []
  const inputs: JsonObject[] = []
  const state = { loseFork: false, loseInput: false }
  const tools = [
    {
      type: "function",
      function: { name: "read" },
      route: { kind: "runner", tool_name: "read", runner_executor_public_id: "runner" },
    },
    {
      type: "function",
      function: { name: "read_other" },
      route: { kind: "runner", tool_name: "read", runner_executor_public_id: "remote" },
    },
    {
      type: "function",
      function: { name: "mcp_read" },
      route: { kind: "mcp", tool_name: "read", connection_public_id: "mcp" },
    },
    {
      type: "function",
      function: { name: "bash" },
      route: { kind: "runner", tool_name: "bash", runner_executor_public_id: "runner" },
    },
  ]
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      if (path.includes("/store_entries")) {
        const scope = path.split("/store_entries")[0]
        const rows = stores.get(scope) ?? new Map<string, StoreEntry>()
        stores.set(scope, rows)
        const id = path.split("/").at(-1)!
        if (request.method === "GET")
          return id === "store_entries"
            ? Response.json({ store_entries: [...rows.values()], pagination: { next_after: null } })
            : rows.has(id)
              ? Response.json({ store_entry: rows.get(id) })
              : Response.json({ error: { code: "not_found" } }, { status: 404 })
        const body = (await request.json()) as { store_entry: StoreEntry }
        if (request.method === "POST") {
          if (
            [...rows.values()].some(
              (row) => row.key === body.store_entry.key && row.namespace === body.store_entry.namespace,
            )
          )
            return Response.json({ error: { code: "key_taken" } }, { status: 409 })
          const row = {
            ...body.store_entry,
            public_id: crypto.randomUUID(),
            lock_version: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          rows.set(row.public_id, row)
          return Response.json({ store_entry: row }, { status: 201 })
        }
        const before = rows.get(id)
        if (!before || before.lock_version !== body.store_entry.lock_version)
          return Response.json({ error: { code: "stale_object" } }, { status: 409 })
        const row = { ...before, value: body.store_entry.value, lock_version: before.lock_version + 1 }
        rows.set(id, row)
        return Response.json({ store_entry: row })
      }
      if (path.endsWith("/tools/assembly")) return Response.json({ tool_definitions: tools, environment: {} })
      if (path.endsWith("/workspaces")) return Response.json({ workspaces: [], pagination: { next_after: null } })
      if (path.endsWith("/conversations"))
        return Response.json({
          conversations: [...conversations.values()].filter((row) => row.side === true),
          pagination: { next_after: null },
        })
      if (path.endsWith("/forks")) {
        const key = request.headers.get("idempotency-key")!
        forkKeys.push(key)
        const row =
          receipts.get(key) ??
          conversationFixture({
            public_id: "side-" + receipts.size,
            answering_user_public_id: conversations.get("parent")!.answering_user_public_id,
            side: true,
            source_conversation_public_id: "parent",
            agent_configuration_present: true,
            default_runner: { executor_public_id: "runner", presence: "online" },
          })
        receipts.set(key, row)
        conversations.set(String(row.public_id), row)
        if (state.loseFork) {
          state.loseFork = false
          return Response.json({ error: { code: "response_lost" } }, { status: 503 })
        }
        return Response.json(
          { conversation: row, runner_effects: { status: "untouched", runners: [] } },
          { status: 201 },
        )
      }
      if (path.endsWith("/inputs")) {
        const body = (await request.json()) as { input: JsonObject }
        inputs.push(body.input)
        if (state.loseInput) {
          state.loseInput = false
          return Response.json({ error: { code: "response_lost" } }, { status: 503 })
        }
        return Response.json(
          {
            input: inputFixture({ ...body.input, attachments: [], public_id: request.headers.get("idempotency-key")! }),
          },
          { status: 202 },
        )
      }
      const id = path.split("/").at(-1)!
      if (request.method === "DELETE" && conversations.has(id)) {
        conversations.delete(id)
        stores.delete(path)
        return new Response(null, { status: 204 })
      }
      if (conversations.has(id)) return Response.json({ conversation: conversations.get(id) })
      return Response.json({ error: { code: "not_found", message: path } }, { status: 404 })
    },
  })
  const events: string[] = []
  const open = () => {
    const app = new NexusApplication(
      new Client({ baseURL: server.url.origin, credential: "fixture" }),
      { agent: "main", runner: "runner", workspace: "workspace" },
      () => ({ default_model: "provider/original" }),
      undefined,
      async () => ({ model: "provider/original", agent_configuration: {}, fallback_models: [] }),
      async (name) => {
        events.push(name)
      },
    )
    app.environments.configure({ root: () => process.cwd() })
    app.lifecycle.adopt("workspace", "parent")
    return app
  }
  return {
    open,
    state,
    inputs,
    forkKeys,
    stores,
    conversations,
    events,
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("Sides reuse the kernel fork and freeze read posture, reference tail and environment through admission retries", async () => {
  using peer = fixture()
  const app = peer.open()
  const opened = await Promise.all([
    app.openSide({ parent: "parent", key: "first", tools: "read" }),
    app.openSide({ parent: "parent", key: "second", tools: "read" }),
  ])
  expect(peer.forkKeys).toEqual(["first"])
  expect(opened.map((row) => row.reused)).toEqual([false, true])
  expect(opened[0].conversation.public_id).toBe(opened[1].conversation.public_id)
  const request = {
    workspace: "workspace",
    conversation: opened[0].conversation.public_id,
    key: "input",
    text: "Inspect the file",
    attachments: ["image"],
    approval: "ask" as const,
    delivery: "queue" as const,
  }
  await expect(app.submit({ ...request, tools: ["mcp_read"] })).rejects.toThrow("cannot expand")
  expect(peer.inputs).toHaveLength(0)
  peer.state.loseInput = true
  await expect(app.submit(request)).rejects.toThrow()
  expect(peer.inputs[0]).toMatchObject({
    inline: [{ role: "user", position: "tail", text: sideLeads.read }],
    tool_names: ["read", "read_other"],
    approval_mode: "ask",
    attachments: ["image"],
    delivery_mode: "queue",
    executor_contexts: { runner: { "opencode.environment": { root: process.cwd(), anchor: "parent" } } },
  })
  expect(peer.inputs[0].agent_configuration).toBeUndefined()
  expect(peer.inputs[0].instructions).toBeUndefined()
  expect(peer.inputs[0].model).toBeUndefined()
  const restored = peer.open()
  const reused = await restored.openSide({ parent: request.conversation, key: "reopen", tools: "write" })
  expect(reused).toMatchObject({ reused: true, tools: "write", parent: { public_id: "parent" } })
  await restored.submit(request)
  expect(peer.inputs[1]).toEqual(peer.inputs[0])
  await restored.submit({ ...request, key: "next" })
  expect(peer.inputs[2].tool_names).toEqual(["read", "read_other", "mcp_read", "bash"])
  expect(peer.inputs[2].inline).toEqual([{ role: "user", position: "tail", text: sideLeads.write }])
})

test("Side fork response loss replays its original key and idle maintenance discovers and deletes owned sides", async () => {
  using peer = fixture()
  const app = peer.open()
  peer.state.loseFork = true
  await expect(app.openSide({ parent: "parent", key: "frozen-fork" })).rejects.toThrow()
  const restored = peer.open()
  const opened = await restored.openSide({ parent: "parent", key: "later-key" })
  expect(peer.forkKeys).toEqual(["frozen-fork", "frozen-fork"])
  expect([...peer.conversations.keys()]).toEqual(["parent", opened.conversation.public_id])
  const policy = await restored.sides.read("workspace", opened.conversation.public_id)
  expect(policy?.tools).toBe("write")
  peer.conversations.set("foreign-side", conversationFixture({ public_id: "foreign-side", side: true }))
  const rediscovered = peer.open()
  expect(await rediscovered.sides.sweep(policy!.last_turn_at + 86399999)).toEqual([])
  expect(rediscovered.lifecycle.hostsSnapshot().some((row) => row.conversation === opened.conversation.public_id)).toBe(
    true,
  )
  expect(await rediscovered.sides.sweep(policy!.last_turn_at + 86400000)).toEqual([opened.conversation.public_id])
  expect(peer.conversations.has("foreign-side")).toBe(true)
  expect(peer.events).toContain("host.ended")
})

test("An owned foreign side preserves its answerer's write declaration and still narrows read posture", async () => {
  using peer = fixture()
  peer.conversations.set("parent", { ...peer.conversations.get("parent")!, answering_user_public_id: "foreign" })
  const app = peer.open()
  const opened = await app.openSide({ parent: "parent", key: "foreign" })
  expect(opened.conversation.answering_user_public_id).toBe("foreign")
  const request = {
    workspace: "workspace",
    conversation: opened.conversation.public_id,
    key: "write",
    text: "Use your own tools",
  }
  await app.submit(request)
  expect(peer.inputs[0].agent_configuration).toBeUndefined()
  expect(peer.inputs[0].executor_contexts).toBeUndefined()
  expect(peer.inputs[0].tool_names).toBeUndefined()
  expect(peer.inputs[0].inline).toEqual([{ role: "user", position: "tail", text: sideLeads.write }])
  await app.openSide({ parent: opened.conversation.public_id, key: "read", tools: "read" })
  await app.submit({ ...request, key: "read" })
  expect(peer.inputs[1].tool_names).toEqual(["read", "read_other"])
  expect(peer.inputs[1].agent_configuration).toBeUndefined()
})

test("Sides inherit the parent's selected model from durable admissions after restart", async () => {
  using peer = fixture()
  await peer
    .open()
    .submit({
      workspace: "workspace",
      conversation: "parent",
      key: "selected",
      text: "Use the selected model",
      model: "provider/selected",
    })
  const app = peer.open()
  const side = await app.openSide({ parent: "parent", key: "fork" })
  await app.submit({
    workspace: "workspace",
    conversation: side.conversation.public_id,
    key: "side-input",
    text: "A side question",
  })
  expect(await app.sides.read("workspace", side.conversation.public_id)).toMatchObject({ model: "provider/selected" })
  expect(peer.inputs.at(-1)?.model).toBeUndefined()
  const request = {
    workspace: "workspace",
    conversation: side.conversation.public_id,
    key: "side-selected",
    text: "Select another model",
    model: "provider/next",
  }
  await app.submit(request)
  const frozen = peer.inputs.at(-1)
  expect(frozen?.model).toEqual({ model: "provider/next" })
  const restored = peer.open()
  await restored.submit(request)
  expect(peer.inputs.at(-1)).toEqual(frozen)
  expect(await restored.sides.read("workspace", side.conversation.public_id)).toMatchObject({ model: "provider/next" })
})
