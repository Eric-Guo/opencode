import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client, type JsonObject, type JsonValue } from "@cybros/agent"
import { RealtimeClient } from "@cybros/agent/realtime"
import { Service } from "@opencode/client/effect/service"
import { Effect, Schema } from "effect"
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

test("development opens an idle conversation and admits attachment-only inputs with the saved route after restart", async () => {
  const inputs: JsonObject[] = []
  const opened: JsonObject[] = []
  const uploaded: string[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/conversations") && request.method === "POST") {
      const { conversation } = (await request.json()) as { conversation: JsonObject }
      opened.push(conversation)
      return Response.json({ conversation: conversationFixture(conversation) }, { status: 201 })
    }
    if (path.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture(opened.at(-1)) })
    if (path.endsWith("/turns"))
      return Response.json({ turns: [], pagination: { before_position: null, after_position: null } })
    if (path.endsWith("/uploads")) {
      const file = (await request.formData()).get("upload[file]")
      if (!(file instanceof File)) throw new Error("Expected a staged attachment")
      uploaded.push(await file.text())
      return Response.json(
        {
          upload: {
            public_id: "upload",
            filename: file.name,
            content_type: file.type,
            byte_size: file.size,
            created_at: "now",
          },
        },
        { status: 201 },
      )
    }
    if (path.endsWith("/inputs") && request.method === "POST") {
      const { input } = (await request.json()) as { input: JsonObject }
      inputs.push(input)
      return Response.json({ input: inputFixture({ state: "blocked", blocked_reason: "run_held" }) }, { status: 202 })
    }
  })
  const terminal = () => {
    const app = new NexusApplication(
      fixture.client,
      { workspace: "workspace", agent: "main", runner: "runner" },
      () => ({}),
      undefined,
      async () => ({ agent_configuration: {}, model: "provider/default", fallback_models: ["provider/fallback"] }),
    )
    const output: string[] = []
    return {
      output,
      command: async (input: JsonObject) => json(JSON.stringify(await app.operations.command(input))),
      signal: new AbortController().signal,
      write: (value: string | Uint8Array) => {
        output.push(value.toString())
      },
      error() {},
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "nexus-attach-"))
  try {
    const first = terminal()
    for (const option of ["--instructions", "--approval", "--until"])
      await expect(runDevelopment(["do", option, "value"], first)).rejects.toThrow(option)
    expect(opened).toHaveLength(0)
    await runDevelopment(["do", "--model", "provider/selected", "--json"], first)
    expect(json(first.output.join(""))).toEqual({ conversation: "conversation" })
    expect(opened).toHaveLength(1)
    expect(inputs).toHaveLength(0)

    const file = join(directory, "note.txt")
    await writeFile(file, "note")
    const restored = terminal()
    await runDevelopment(["say", "conversation", "--attach", file, "--json"], restored)
    expect(json(restored.output.join(""))).toEqual({
      conversation: "conversation",
      input: "input",
      status: "blocked",
      blocked_reason: "run_held",
    })
    expect(inputs[0]).toMatchObject({
      text: "",
      attachments: ["upload"],
      delivery_mode: "queue",
      model: { model: "provider/selected" },
      model_selection: { source: "explicit", model: "provider/selected", constraint: "route", alternatives: [] },
      fallback_models: ["provider/fallback"],
    })
    await runDevelopment(["do", "--attach", file, "--model", "provider/new"], restored)
    expect(inputs[1]).toMatchObject({
      text: "",
      attachments: ["upload"],
      delivery_mode: "queue",
      model: { model: "provider/new" },
    })
    expect(uploaded).toEqual(["note", "note"])
  } finally {
    fixture.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("watch times out while waiting for the first run without opening a subscription", async () => {
  const calls: string[] = []
  await expect(
    runDevelopment(["watch", "chat", "--timeout", "0"], {
      signal: AbortSignal.timeout(1000),
      command: async (input) => {
        calls.push(String(input.action))
        return { workspace: "workspace", conversation: "chat", side: false, run: null }
      },
      write() {},
      error() {},
    }),
  ).rejects.toThrow("Timed out watching chat")
  expect(calls.every((action) => action === "target")).toBe(true)
})

for (const verb of ["watch", "follow"])
  test(verb + " recovers both transcript tails from a gap without replaying retained deltas", async () => {
    const output: string[] = []
    const calls: string[] = []
    const code = await runDevelopment([verb, "run", ...(verb === "follow" ? ["--reasoning"] : []), "--timeout", "0"], {
      signal: AbortSignal.timeout(1000),
      command: async (input): Promise<JsonValue> => {
        calls.push(String(input.action))
        switch (input.action) {
          case "target":
            return { workspace: "workspace", conversation: "chat", run: "run", side: false }
          case "stream.open":
            return { stream: "id", text: "A", text_length: 1, reasoning: "", reasoning_length: 0 }
          case "stream.poll":
            return {
              lost: 2,
              text: "A界C",
              text_length: 5,
              reasoning: "reason",
              reasoning_length: 6,
              events: [
                { channel: "transcript", frame: { type: "text_delta", payload: { text: "C" } } },
                { channel: "transcript", frame: { type: "reasoning_delta", payload: { text: "on" } } },
              ],
            }
          case "run":
            return { status: "completed", tasks: [] }
          case "run.result":
            return { output: "A界C" }
          case "stream.close":
            return null
          default:
            throw new Error(String(input.action))
        }
      },
      write: (value) => {
        output.push(String(value))
      },
      error() {},
    })
    expect(code).toBe(0)
    expect(output.filter((line) => line.trim() && !line.startsWith("status:")).sort()).toEqual(
      (verb === "follow" ? ["A", "界C", "reason"] : ["A", "界C"]).sort(),
    )
    expect(calls.at(-1)).toBe("stream.close")
  })

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

test("development compact and attach address exactly one conversation or run", async () => {
  const writes: string[] = []
  const streams: JsonObject[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname.split("/workspaces/workspace/")[1]
    if (request.method === "POST") writes.push(path)
    if (path === "conversations/chat")
      return Response.json({ conversation: conversationFixture({ public_id: "chat", active_turn_public_id: "turn" }) })
    if (path === "conversations/chat/turns/turn/variants")
      return Response.json({
        turn: { public_id: "turn" },
        variants: [{ public_id: "v", source: "model", status: "running", active: true, run_public_id: "current" }],
      })
    if (path === "runs/old")
      return Response.json({
        run: { public_id: "old", status: "running", turn: { conversation_public_id: "chat", status: "running" } },
      })
    if (path === "conversations/chat/compaction")
      return Response.json(
        { turn: { public_id: "turn", position: 1, kind: "summary", status: "running" } },
        { status: 202 },
      )
    if (path === "runs/old/tasks/round/compact")
      return Response.json({ task, summary_task_key: "summary" }, { status: 202 })
    return Response.json({ error: { code: "not_found" } }, { status: 404 })
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  const terminal = {
    signal: new AbortController().signal,
    async command(input: JsonObject) {
      if (input.action !== "stream.attach") return json(JSON.stringify(await application.operations.command(input)))
      streams.push(input)
      return null
    },
    write() {},
    error() {},
  }
  try {
    await expect(runDevelopment(["compact", "old", "--host-type", "run"], terminal)).rejects.toThrow(/round|task/i)
    await expect(runDevelopment(["compact", "chat", "round"], terminal)).rejects.toThrow(/conversation/i)
    expect(writes).toEqual([])
    await runDevelopment(["compact", "chat"], terminal)
    await runDevelopment(["compact", "old", "round"], terminal)
    expect(writes).toEqual(["conversations/chat/compaction", "runs/old/tasks/round/compact"])

    await runDevelopment(["attach", "old", "--no-live"], terminal)
    expect(application.lifecycle.hostsSnapshot()).toEqual([])
    await runDevelopment(["attach", "chat", "--conversation"], terminal)
    expect(application.lifecycle.hostsSnapshot()).toEqual([{ workspace: "workspace", conversation: "chat" }])
    expect(streams).toEqual([{ action: "stream.attach", addressed: true, run: "old", live: false }])
  } finally {
    fixture.server.stop(true)
  }
})

test("development prompt preview uses the next input's declaration and model without admitting input", async () => {
  const estimates: JsonObject[] = []
  const rendered = {
    input_tokens: 7,
    tokenizer_exact: true,
    catalog_input_token_limit: 1000,
    advisory_input_token_limit: null,
    message_count: 1,
    history: { selected: 1, skipped: 0, skipped_reason: null, compacted: 0 },
    rendered: {
      mechanism: "assembly",
      storage: { bytes: 12, bound: 1000, within_bound: true, refusal: null },
      blocks: [{ index: 0, block: "input", type: "input", role: "user", state: "selected", tokens: 7 }],
      slots: {},
      memory: { included: 0, omitted: 0 },
      entries: [{ role: "user", parts: [{ type: "text", text: "Preview text" }] }],
    },
  }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname

    if (path.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture({ answering_user_public_id: "main" }) })
    if (path.endsWith("/turns")) return Response.json({ turns: [], pagination: {} })
    if (path.endsWith("/context_estimate")) {
      estimates.push(object(object(await request.json()).context_estimate))
      return Response.json({ context_estimate: { ...rendered, ...rendered.rendered } })
    }
    if (!["GET", "HEAD"].includes(request.method) && !path.endsWith("/store_entries"))
      throw new Error("Unexpected mutation in prompt preview")
  })
  const policy = {
    model: "provider/default",
    agent_configuration: { system_prompt: { content: "Current declaration" } },
    fallback_models: ["provider/fallback"],
  }
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
    undefined,
    async () => policy,
  )
  const output: string[] = []
  const terminal = {
    signal: new AbortController().signal,
    command: async (input: JsonObject) => json(JSON.stringify(await application.operations.command(input))),
    write: (text: string | Uint8Array) => {
      output.push(text.toString())
    },
    error: () => {},
    read: async () => JSON.stringify({ blocks: [{ type: "input" }] }),
  }

  try {
    const args = [
      "prompt",
      "preview",
      "conversation",
      "--prompt",
      "Preview text",
      "--var",
      "mood=calm=ish",
      "--template",
      "-",
    ]

    await runDevelopment(args, terminal)
    expect(estimates[0]).toMatchObject({
      render: true,
      model: { model: "provider/default" },
      answering_user_public_id: "main",
      agent_configuration: policy.agent_configuration,
      fallback_models: policy.fallback_models,
      variables: { mood: "calm=ish" },
      template: { blocks: [{ type: "input" }] },
    })
    expect(output[0]).toContain("mechanism: assembly")
    expect(output[0]).toContain('"text": "Preview text"')
    expect(fixture.state.writes).toBe(0)

    await application.captureInput({
      workspace: "workspace",
      conversation: "conversation",
      key: "prior",
      text: "Earlier",
      model: "provider/remembered",
    })
    const writes = fixture.state.writes

    await runDevelopment([...args, "--json"], terminal)
    await runDevelopment([...args, "--model", "provider/override"], terminal)
    expect(estimates.slice(1).map((estimate) => estimate.model)).toEqual([
      { model: "provider/remembered" },
      { model: "provider/override" },
    ])
    expect(json(output[1])).toMatchObject(rendered)
    expect(fixture.state.writes).toBe(writes)
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
  const created: JsonObject[] = []
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
    if (path.endsWith("/conversations") && request.method === "POST") {
      created.push(object(object(await request.json()).conversation))
      return Response.json({ conversation: conversationFixture(created.at(-1)) }, { status: 201 })
    }
    if (path.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture(created.at(-1)) })
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

    state.dedicated = false
    await application.open({ key: "foreign-open", agent: "@helper", model: "foreign/opening" })
    await application.submit({ ...input, key: "first-foreign" })
    expect(submitted.at(-1)?.model).toEqual({ model: "foreign/opening" })
    expect(submitted.at(-1)).not.toHaveProperty("model_selection")
    await application.submit({ ...input, key: "next-foreign", model: "foreign/replacement" })
    await application.submit({ ...input, key: "main", answering_user_public_id: "main" })
    expect(submitted.at(-1)?.model).toEqual({ model: "main-model" })
    await application.submit({ ...input, key: "return-foreign" })
    expect(submitted.at(-1)?.model).toEqual({ model: "foreign/replacement" })
  } finally {
    fixture.server.stop(true)
  }
})

test("development live streams use daemon credentials, carry transcript frames and close only their subscription", async () => {
  const subscribed = Promise.withResolvers<(text: string) => void>()
  const closed = Promise.withResolvers<void>()
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
        subscribed.resolve((text) =>
          socket.send(
            JSON.stringify({
              identifier: request.identifier,
              message: { event: { type: "text_delta", run_public_id: "run", text } },
            }),
          ),
        )
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
    const slower = object(await streams.command({ action: "stream.open", run: "run" })).stream
    const send = await subscribed.promise
    send("prefix")
    send("x".repeat(1024 * 1024))
    send("suffix")
    const deadline = performance.now() + 2000
    while (performance.now() < deadline) {
      const page = object(await streams.command({ action: "stream.poll", stream }))
      if (JSON.stringify(page.events).includes("suffix")) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const page = object(await streams.command({ action: "stream.poll", stream: slower }))
    expect(page).toMatchObject({ lost: 1, text_length: 1024 * 1024 + 12 })
    expect(String(page.text)).toEndWith("suffix")
    expect(page.events).toMatchObject([
      { frame: { payload: { text: "prefix" } } },
      { frame: { payload: { text: "suffix" } } },
    ])
    expect(await streams.command({ action: "stream.poll", stream: slower })).toMatchObject({ events: [], lost: 0 })
    await streams.command({ action: "stream.close", stream: slower })
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
  const envelopes: unknown[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    requests.push({ path, method: request.method, key: request.headers.get("idempotency-key") })
    if (path.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture({ active_turn_public_id: "new-turn" }) })
    if (path.endsWith("/regeneration_receipt")) return Response.json(receipt)
    if (path.endsWith("/regeneration")) {
      envelopes.push(await request.json())
      if (envelopes.length === 3)
        return Response.json(
          { error: { code: "idempotency_envelope_mismatch", message: "Different intent" } },
          { status: 409 },
        )
      return Response.json(receipt, { status: 202 })
    }
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
    const intent = {
      source: "explicit",
      model: "chosen/model",
      constraint: "provider",
      alternatives: ["chosen/alternate"],
    }
    const command = {
      action: "regenerate",
      conversation: "conversation",
      turn: "old-turn",
      key: "selected",
      model_selection: intent,
      fallback_models: [],
    }
    await application.operations.command(command)
    expect(await application.operations.command({ ...command, key: "stable" })).toMatchObject({
      restoration: { status: "unchanged", door_refused: "idempotency_envelope_mismatch" },
    })
    expect(envelopes).toEqual(
      [{}, ...Array(2).fill({ model_selection: intent, fallback_models: [] })].map((regeneration) => ({
        regeneration,
      })),
    )
    expect(
      requests
        .filter((request) => request.method === "POST")
        .every((request) => request.path.endsWith("/old-turn/regeneration")),
    ).toBe(true)
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

test("source CLI discovers the installed channel, authenticates privately, and follows mainline rounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-dev-service-"))
  const requests: JsonObject[] = []
  const round = (task_key: string) => ({
    task_key,
    status: "completed",
    mainline: true,
    calls: { count: 0, items: [] },
  })
  const frame = (channel: string, type: string, key: string, payload: JsonObject, run = "run") => ({
    channel,
    frame: { type, task_key: key, run_public_id: run, payload },
  })
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Basic " + btoa("opencode:private-fixture"))
      const path = new URL(request.url).pathname
      if (path === "/api/info") return Response.json({ pid: process.pid, version: "fixture" })
      if (path.endsWith("/extensions")) return Response.json([{ id: "nexus.dev", active: true, enabled: true }])
      if (path.endsWith("/status")) return Response.json({ workspace: "workspace" })
      const input = object(object(await request.json()).input)
      requests.push(input)
      switch (input.action) {
        case "target":
          return Response.json({ workspace: "workspace", run: "run", conversation: null, side: false })
        case "stream.open":
          return Response.json({ stream: "reader" })
        case "transcript":
          return Response.json({ rounds: [round("r1"), round("r2")], has_older: true, next_before: "earlier" })
        case "stream.poll":
          return Response.json({
            events: [
              frame("progress", "round_started", "r3", { mainline: true }),
              frame("progress", "step_started", "r3t1", { status: "running" }),
              frame("progress", "step_claimed", "r3t1", {}),
              frame("transcript", "call", "r3t1", { call: { task_key: "r3t1", name: "read" } }),
              frame("transcript", "round", "r3", { round: { ...round("r3"), text_preview: "settled" } }),
              frame("progress", "round_started", "r4", { mainline: false }),
              frame("progress", "step_started", "r4t1", {}),
              frame("transcript", "round", "r4", { round: { ...round("r4"), mainline: false } }),
              frame("transcript", "round", "r5", { round: round("r5") }, "other-run"),
            ],
            lost: 0,
          })
        case "run":
          return Response.json({ status: "completed" })
        case "stream.close":
          return Response.json(null)
        default:
          throw new Error("Unexpected action " + input.action)
      }
    },
  })
  const invoke = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../dev/cli.ts"), "transcript", "run", "--follow", ...args],
      {
        env: { ...process.env, XDG_STATE_HOME: directory, PATH: directory + "/bin:" + process.env.PATH },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, output, error] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()])
    return { code, output, error }
  }
  try {
    await Promise.all([mkdir(join(directory, "opencode")), mkdir(join(directory, "bin"))])
    await writeFile(
      join(directory, "opencode", "service-fixture.json"),
      JSON.stringify({
        url: server.url.origin,
        password: "private-fixture",
        pid: process.pid,
        version: "fixture",
        provenance: await Effect.runPromise(Service.provenance),
      }),
      { mode: 0o600 },
    )
    await writeFile(
      join(directory, "bin", "opencode"),
      `#!/bin/sh
case "$*" in
"service status") echo "${server.url.origin}" ;;
"service get password") echo unrelated-configuration ;;
*) exit 2 ;;
esac
`,
      { mode: 0o700 },
    )
    expect(await invoke("--prefix", "r4t1")).toMatchObject({ code: 1, error: expect.stringContaining("--prefix") })
    expect(requests).toEqual([])
    const result = await invoke("--before", "cursor", "--limit", "2", "--json")
    expect(result).toMatchObject({ code: 0, error: "older: earlier\n" })
    expect(
      result.output
        .trim()
        .split("\n")
        .map((line) => object(JSON.parse(line))),
    ).toEqual([
      round("r1"),
      round("r2"),
      { live: ["r3"] },
      { live: ["r3", "r3t1"] },
      { live: ["r3"] },
      { ...round("r3"), text_preview: "settled" },
      { live: [] },
    ])
    expect(requests.filter((request) => request.action === "transcript")).toMatchObject([
      { before: "cursor", limit: 2 },
    ])
    expect(requests.at(-1)).toMatchObject({ action: "stream.close" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("development task reporting explains unresolved model holds and omits resolved and absorbed failures", async () => {
  const hints: string[] = []
  const reports: JsonObject[] = []
  const terminal = {
    signal: new AbortController().signal,
    command: async (input: JsonObject): Promise<JsonObject> =>
      input.action === "target"
        ? { workspace: "w", conversation: null, run: "run", side: false }
        : { task: reports.shift()! },
    write: () => {},
    error: (line: string) => hints.push(line),
  } satisfies Parameters<typeof runDevelopment>[1]
  const held = { kind: "model_task", status: "failed", error: { key: "provider_context_overflow" } }
  for (const task of [
    held,
    { ...held, error: { key: "conversation_cost_limit_reached" }, on_failure: "absorb" },
    { ...held, failure_resolution: "retry" },
    { ...held, on_failure: "absorb" },
    { ...held, kind: "tool_task" },
  ]) {
    reports.push(task)
    await runDevelopment(["task", "run", "r1"], terminal)
  }
  expect(hints).toEqual([
    expect.stringContaining("Input token limit"),
    expect.stringContaining("retry the held model task"),
  ])
})

test("development skills list reports runner documents and distinguishes an empty project from an unbound runner", async () => {
  const fixture = storeFixture(() => Response.json({ memory_collections: [], pagination: { next_after: null } }))
  const app = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  const lines: string[] = []
  const terminal = {
    command: async (input: JsonObject) => json(JSON.stringify(await app.operations.command(input))),
    write: (value: string | Uint8Array) => {
      lines.push(value.toString())
    },
    error() {},
    signal: new AbortController().signal,
  }
  try {
    await runDevelopment(["skills"], terminal)
    expect(lines.join("")).toContain("project (no runner root set)")
    app.environments.configure({ root: () => process.cwd() })
    lines.length = 0
    await runDevelopment(["skills"], terminal)
    expect(lines.join("")).toContain("project (announced by this runner)\n  (none)")
    const docs = [{ name: "review", description: "Review a change" }]
    app.environments.configure({ root: () => process.cwd(), documents: () => docs })
    lines.length = 0
    await runDevelopment(["skills", "--json"], terminal)
    expect(json(lines.join(""))).toMatchObject({ agent: [], workspace: [], project: docs })
    lines.length = 0
    await runDevelopment(["skills"], terminal)
    expect(lines.join("")).toContain("project (announced by this runner)\n  review: Review a change")
  } finally {
    fixture.server.stop(true)
  }
})
