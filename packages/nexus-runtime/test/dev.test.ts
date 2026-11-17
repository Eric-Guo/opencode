import { expect, test } from "bun:test"
import { Client, type JsonObject } from "@cybros/agent"
import { RealtimeClient } from "@cybros/agent/realtime"
import { Schema } from "effect"
import { NexusApplication } from "../src/application"
import type { ApprovalGrant } from "../src/approval-grant"
import { runDevelopment, parseDevelopment } from "../dev/terminal"
import { DevelopmentStreams } from "../dev/streams"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture } from "./fixture/conversation"

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))
const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))
const task = {
  key: "reply",
  kind: "model_task",
  status: "completed",
  lifetime: "foreground",
  wake: "eager",
  after: [],
  waiting_on: [],
  approval: null,
}

test("development CLI preserves exact old-run results, explicit pause force, authored steps and resolution tokens", async () => {
  const writes: { path: string; body: unknown }[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method !== "GET") writes.push({ path, body: request.body ? await request.json() : null })
    if (path.endsWith("/conversations/old")) return Response.json({ error: { code: "not_found" } }, { status: 404 })
    if (path.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture({ active_turn_public_id: "new-turn" }) })
    if (path.endsWith("/runs/old") || path.endsWith("/runs/old/pause"))
      return Response.json({
        run: {
          public_id: "old",
          status: "completed",
          deliverable_task_key: "reply",
          turn: { status: "completed", conversation_public_id: "conversation" },
        },
      })
    if (path.endsWith("/tasks/reply")) return Response.json({ task: { ...task, output: "Original candidate" } })
    if (path.endsWith("/resolution")) return Response.json({ task })
    if (path.endsWith("/tasks"))
      return Response.json(
        { receipt: { accepted_task_keys: ["appended"], steps: [], resolution_tokens: {}, replayed: false } },
        { status: 201 },
      )
    return Response.json({ error: { code: "unexpected" } }, { status: 400 })
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  const output: string[] = []
  const terminal = {
    signal: new AbortController().signal,
    command: async (input: JsonObject) => json(JSON.stringify((await application.operations.command(input)) ?? null)),
    write: (text: string | Uint8Array) => {
      output.push(text.toString())
    },
    error: () => {},
    read: async () =>
      JSON.stringify([{ ask: { prompt: "Continue?", key: "appended", options: ["yes"], multi: false } }]),
  }
  try {
    expect(parseDevelopment(["pause", "old", "--force"]).values.force).toBe(true)
    expect(parseDevelopment(["watch", "old", "--no-stream"]).values.stream).toBe(false)
    expect(await runDevelopment(["result", "old"], terminal)).toBe(0)
    expect(output.join("")).toContain("Original candidate")
    await runDevelopment(["pause", "old"], terminal)
    expect(writes.at(-1)?.body).toEqual({ force: false })
    await runDevelopment(["pause", "old", "--force"], terminal)
    expect(writes.at(-1)?.body).toEqual({ force: true })
    await runDevelopment(["append", "old", "-f", "-"], terminal)
    expect(writes.at(-1)?.body).toEqual({
      steps: [{ ask: { prompt: "Continue?", key: "appended", options: ["yes"], multi: false } }],
    })
    await runDevelopment(["answer", "old", "reply", "no", "--token", "resolution", "--outcome", "failed"], terminal)
    expect(writes.at(-1)?.body).toEqual({ content: "no", resolution_token: "resolution", outcome: "failed" })
  } finally {
    fixture.server.stop(true)
  }
})

test("development queued edits preserve optimistic versions and clear scheduling with the typed immediate delay", async () => {
  const writes: unknown[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
    if (path.endsWith("/turns")) return Response.json({ turns: [], pagination: {} })
    if (path.endsWith("/inputs"))
      return Response.json({
        inputs: [inputFixture({ public_id: "queued", lock_version: 7 })],
        input_queue: { limit: 100, held: 1 },
      })
    if (path.endsWith("/inputs/queued")) {
      writes.push(await request.json())
      return Response.json({ input: inputFixture({ public_id: "queued", lock_version: 8 }) })
    }
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  try {
    await runDevelopment(["inputs", "edit", "conversation", "queued", "--now"], {
      signal: new AbortController().signal,
      command: async (input) => json(JSON.stringify((await application.operations.command(input)) ?? null)),
      write: () => {},
      error: () => {},
    })
    expect(writes).toEqual([{ input: { expected_lock_version: 7, deliver_in: "0s" } }])
  } finally {
    fixture.server.stop(true)
  }
})

test("approval grants validate raw boundaries before approval and declare process-local provenance afterwards", async () => {
  const order: string[] = []
  const grants: ApprovalGrant[] = []
  const held = {
    tool_name: "bash",
    tool_input: { command: "npm install\n" } as JsonObject,
    target: null as JsonObject | null,
    tool_alias: null as string | null,
  }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/runs/run")) return Response.json({ run: { public_id: "run", status: "needs_attention" } })
    if (path.endsWith("/tasks/call"))
      return Response.json({ task: { ...task, ...held, key: "call", kind: "tool_task", status: "needs_approval" } })
    if (path.endsWith("/approve")) {
      order.push("approved")
      return Response.json({ task: { ...task, key: "call" } })
    }
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      list: () => grants,
      grant: async (grant) => {
        order.push("declared")
        grants.push(grant)
      },
    },
  )
  try {
    await expect(
      application.operations.command({ action: "approve", run: "run", task: "call", match: "np" }),
    ).rejects.toThrow("whole-token")
    expect(order).toEqual([])
    await application.operations.command({ action: "approve", run: "run", task: "call", always: true })
    expect(order).toEqual(["approved", "declared"])
    expect(grants[0]).toMatchObject({
      run: "run",
      task: "call",
      rule: { tool: "bash", path: "command", match: "npm install\n", verdict: "allow" },
    })
    await application.operations.command({ action: "approve", run: "run", task: "call", match: "npm " })
    expect(grants[1].rule.match).toBe("npm *")
    held.tool_name = "write"
    held.target = { kind: "mcp" }
    held.tool_alias = "mcp__fixture__write"
    await application.operations.command({ action: "approve", run: "run", task: "call", always: true })
    expect(grants[2].rule).toEqual({ tool: "mcp__fixture__write", verdict: "allow" })
    held.target = null
    held.tool_name = "web_fetch"
    held.tool_input = { url: "HTTPS://Example.com:00443/a" }
    await application.operations.command({ action: "approve", run: "run", task: "call", always: true })
    expect(grants[3].rule).toEqual({
      tool: "web_fetch",
      path: "url",
      match: "HTTPS://Example.com:00443/*",
      verdict: "allow",
    })
    held.tool_input = { url: "https://exam\nple.com/a" }
    await expect(
      application.operations.command({ action: "approve", run: "run", task: "call", always: true }),
    ).rejects.toThrow("HTTP(S)")
    expect(grants).toHaveLength(4)
  } finally {
    fixture.server.stop(true)
  }
})

test("explicit workspace member addressing preserves recipient policy and immutable admission receipts", async () => {
  const submitted: JsonObject[] = []
  const state = { dedicated: false, preparations: 0 }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/principals"))
      return Response.json({ principals: [{ public_id: "foreign", handle: "helper", kind: "agent" }] })
    if (path.endsWith("/workspaces/workspace"))
      return Response.json({
        workspace: {
          public_id: "workspace",
          name: "Room",
          access_mode: "account_wide",
          state: "active",
          dedicated: state.dedicated,
          lock_version: 0,
          created_at: "now",
          updated_at: "now",
          metadata: {},
          tool_provider_overrides: {},
          owner: { public_id: "owner" },
          creator: { public_id: "human", kind: "human" },
        },
      })
    if (path.endsWith("/profile/agents")) return Response.json({ agents: [] })
    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
    if (path.endsWith("/inputs")) {
      const input = object(object(await request.json()).input)
      submitted.push(input)
      return Response.json({ input: inputFixture(input) }, { status: 202 })
    }
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
    undefined,
    async () => {
      state.preparations++
      return {
        agent_configuration: { instructions: "Main only" },
        model: "main-model",
        fallback_models: [],
        tools: ["main_tool"],
      }
    },
  )
  const input = {
    workspace: "workspace",
    conversation: "conversation",
    key: "addressed",
    text: "Please help",
    addressed: true,
    answering_user_public_id: "@helper",
    delivery: "queue" as const,
    deliver_in: "20m",
  }
  try {
    await application.submit(input)
    await application.submit(input)
    expect(submitted).toEqual([
      {
        kind: "direct_reply",
        text: "Please help",
        answering_user_public_id: "foreign",
        delivery_mode: "queue",
        deliver_in: "20m",
      },
      {
        kind: "direct_reply",
        text: "Please help",
        answering_user_public_id: "foreign",
        delivery_mode: "queue",
        deliver_in: "20m",
      },
    ])
    expect(state.preparations).toBe(0)
    state.dedicated = true
    await expect(application.submit({ ...input, key: "dedicated" })).rejects.toThrow("dedicated")
    expect(submitted).toHaveLength(2)
    await expect(application.submit({ ...input, key: "ordinary", addressed: false })).rejects.toThrow("Main Agent")
  } finally {
    fixture.server.stop(true)
  }
})

test("development live streams use daemon credentials, carry transcript frames and close only their subscription", async () => {
  const subscribed = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const received = Promise.withResolvers<void>()
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      requests.push(request.method + " " + new URL(request.url).pathname)
      expect(request.headers.get("authorization")).toBe("Bearer fixture")
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "actioncable-v1-json" } })) return
      return Response.json({ run: { public_id: "run", status: "running" } })
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "welcome" }))
      },
      message(socket, message) {
        const request = Schema.decodeUnknownSync(Schema.Struct({ command: Schema.String, identifier: Schema.String }))(
          JSON.parse(message.toString()),
        )
        if (request.command !== "subscribe") return
        socket.send(JSON.stringify({ type: "confirm_subscription", identifier: request.identifier }))
        const identifier = object(JSON.parse(request.identifier))
        if (identifier.items !== "transcript") return
        socket.send(
          JSON.stringify({
            identifier: request.identifier,
            message: { event: { type: "text_delta", run_public_id: "run", text: "Live words" } },
          }),
        )
        subscribed.resolve()
      },
      close() {
        closed.resolve()
      },
    },
  })
  const options = { baseURL: server.url.origin, credential: "fixture" }
  const application = new NexusApplication(
    new Client(options),
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => new RealtimeClient(options),
  )
  const streams = new DevelopmentStreams(() => application, new AbortController().signal)
  try {
    const stream = object(await streams.command({ action: "stream.open", run: "run" })).stream
    await subscribed.promise
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      const page = object(await streams.command({ action: "stream.poll", stream }))
      if (JSON.stringify(page).includes("Live words")) {
        received.resolve()
        break
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await received.promise
    await streams.command({ action: "stream.close", stream })
    await closed.promise
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
    await expect(streams.command({ action: "stream.poll", stream })).rejects.toThrow("closed")
  } finally {
    await streams.close()
    server.stop(true)
  }
})

test("skill publication carries the observed revision and never retries a conflicting replacement", async () => {
  const writes: unknown[] = []
  const reads: string[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/memory_collections"))
      return Response.json({
        memory_collections: [
          {
            public_id: "collection",
            name: null,
            description: null,
            scope: "agent",
            owner_public_id: "main",
            is_default: true,
            lock_version: 0,
            created_at: "now",
            updated_at: "now",
            writable: true,
            manageable: true,
          },
        ],
        pagination: { next_after: null },
      })
    if (path.endsWith("/documents/show")) {
      const body = (await request.json()) as { memory: { path: string } }

      reads.push(body.memory.path)
      return Response.json({
        memory: {
          collection_public_id: "collection",
          public_id: "observed",
          lock_version: 8,
          path: "skills/example",
          bytesize: 4,
          content: "old",
          written_at: "now",
        },
      })
    }
    if (path.endsWith("/documents")) {
      writes.push(await request.json())
      return Response.json({ error: { code: "stale_object" } }, { status: 409 })
    }
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  try {
    for (const action of ["skill.show", "skill.remove", "skill.push"] as const)
      await expect(
        application.operations.command({
          action,
          scope: "agent",
          name: "a" + "-a".repeat(32),
          ...(action === "skill.push" ? { description: "Too long", content: "Body" } : {}),
        }),
      ).rejects.toThrow("Invalid skill name")

    expect(reads).toEqual([])
    expect(writes).toEqual([])
    await application.operations.command({ action: "skill.show", scope: "agent", name: "a-".repeat(31) + "aa" })
    expect(reads).toEqual(["skills/" + "a-".repeat(31) + "aa"])
    await expect(
      application.operations.command({
        action: "skill.push",
        scope: "agent",
        name: "example",
        description: "Example",
        content: "New body",
      }),
    ).rejects.toMatchObject({ status: 409 })
    expect(writes).toEqual([
      {
        memory: {
          path: "skills/example",
          content: "New body",
          description: "Example",
          expected_public_id: "observed",
          expected_lock_version: 8,
        },
      },
    ])
  } finally {
    fixture.server.stop(true)
  }
})

test("regeneration receipt replay never restores checkpoints or redirects a formerly accepted candidate", async () => {
  const requests: { path: string; method: string; key: string | null }[] = []
  const receipt = {
    turn: { public_id: "old-turn", status: "running" },
    variant: { public_id: "retry", source: "model", status: "running", active: true, run_public_id: "retry-run" },
  }
  const fixture = storeFixture((request) => {
    const path = new URL(request.url).pathname
    requests.push({ path, method: request.method, key: request.headers.get("idempotency-key") })
    if (path.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture({ active_turn_public_id: "new-turn" }) })
    if (path.endsWith("/regeneration_receipt")) return Response.json(receipt)
    if (path.endsWith("/regeneration")) return Response.json(receipt, { status: 202 })
    return Response.json({ error: { code: "unexpected" } }, { status: 400 })
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  try {
    expect(
      await application.operations.command({
        action: "regenerate",
        conversation: "conversation",
        turn: "old-turn",
        key: "stable",
      }),
    ).toMatchObject({
      turn_public_id: "old-turn",
      variant: { public_id: "retry" },
      restoration: { status: "unchanged" },
    })
    expect(requests).toHaveLength(3)
    expect(requests.at(-1)).toEqual({
      path: "/agent_api/v1/workspaces/workspace/conversations/conversation/turns/old-turn/regeneration",
      method: "POST",
      key: "stable",
    })
  } finally {
    fixture.server.stop(true)
  }
})

test("one-shot tool requests capture runner placement, retain author guard rules and stop an unsuccessful request", async () => {
  const writes: { path: string; body: unknown }[] = []
  const rule = { tool: "bash", path: "command", match: "rm -rf /*", verdict: "deny" }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === "POST") writes.push({ path, body: request.body ? await request.json() : null })
    if (path.endsWith("/profile"))
      return Response.json({
        member: { public_id: "main", kind: "agent", handle: "main", role: "member" },
        credential: { plane: "member" },
        measured_at: "now",
        configuration: {
          tool_definitions: [],
          kernel_tools: [],
          runner_executor_public_ids: ["runner"],
          mcp_tools: [],
          fallback_models: [],
          approval_rules: [rule],
        },
      })
    if (path.endsWith("/executors"))
      return Response.json({
        executors: [
          {
            public_id: "runner",
            kind: "runner",
            status: "active",
            service_roles: ["runner"],
            presence: "connected",
            services: {
              runner: {
                environment: { root: "/captured" },
                tools: [{ name: "bash", effect_profile: {} }],
                documents: [],
              },
            },
          },
        ],
      })
    if (path.endsWith("/runs") && request.method === "POST")
      return Response.json(
        {
          run: { public_id: "relay", status: "pending" },
          receipt: { accepted_task_keys: ["call_tool"], steps: [], resolution_tokens: {} },
        },
        { status: 201 },
      )
    if (path.endsWith("/tasks/call_tool"))
      return Response.json({
        task: { ...task, key: "call_tool", kind: "tool_task", status: "failed", error: { key: "fixture_failure" } },
      })
    return Response.json({ run: { public_id: "relay", status: "running", deliverable_task_key: "call_tool" } })
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  try {
    expect(
      await application.operations.command({
        action: "call_tool",
        runner: "runner",
        tool: "bash",
        input: { command: "false" },
        key: "relay",
        timeout: 2000,
      }),
    ).toMatchObject({ public_id: "relay", task: { task: { status: "failed" } } })
    expect(writes[0].body).toMatchObject({
      run: {
        approval_rules: [{ ...rule, origin: "author" }],
        steps: [
          {
            tool: {
              name: "bash",
              timeout_ms: 2000,
              executor_context: { "opencode.environment": { root: "/captured", directories: [], anchor: null } },
            },
          },
        ],
      },
    })
    expect(writes.at(-1)).toEqual({ path: "/agent_api/v1/workspaces/workspace/runs/relay/stop", body: { force: true } })
  } finally {
    fixture.server.stop(true)
  }
})
