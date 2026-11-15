import { expect, test } from "bun:test"
import { agent, client, type AnyMessage, type SessionNotification } from "@agentclientprotocol/sdk"
import { Client, type JsonObject } from "@cybros/agent"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editor, editorPrompt } from "../src/editor"
import { editorBridge, editorRoots } from "../src/editor-bridge"
import { EditorTranscript } from "../src/editor-follow"
import { NexusApplication } from "../src/application"
import { storeFixture } from "./fixture/store"
import { conversationFixture } from "./fixture/conversation"

test("ACP initializes without kernel requests and authenticates before session setup", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls.push(request.url)
      return new Response("Unavailable", { status: 503 })
    },
  })
  const inbound = new TransformStream<AnyMessage>()
  const outbound = new TransformStream<AnyMessage>()
  const work = editor(
    { readable: inbound.readable, writable: outbound.writable },
    { state: "unpaired", origin: server.url.origin, directory: process.cwd(), workspace: "", model: "model" },
    "",
  )
  const peer = client().connect({ readable: outbound.readable, writable: inbound.writable })

  try {
    const response = await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} })

    expect(response.authMethods).toMatchObject([{ id: "nexus" }])
    expect(response.agentCapabilities).toMatchObject({
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
    })
    expect(calls).toEqual([])
    await expect(peer.agent.request("authenticate", { methodId: "nexus" })).rejects.toMatchObject({ code: -32000 })
    expect(calls).toEqual([])
  } finally {
    peer.close()
    await inbound.writable.close()
    await work
    server.stop(true)
  }
})

test("ACP restores history, persists mode changes, resumes without replay and closes without canceling accepted work", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nexus-editor-")))
  const updates: SessionNotification[] = []
  const calls: string[] = []
  const metadata: { value: JsonObject } = { value: {} }
  const question = { restored: false, loaded: false }
  const elicited = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<{ action: "cancel" }>()
  const held = Promise.withResolvers<void>()
  const ask = {
    key: "ask",
    kind: "ask_task",
    status: "awaiting_input",
    lifetime: "foreground",
    wake: "immediate",
    after: [],
    waiting_on: [],
    prompt: "Continue?",
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname

      calls.push(request.method + " " + path)
      if (path.endsWith("/profile"))
        return Response.json({
          member: { public_id: "human", handle: "human", kind: "human", role: "admin" },
          credential: { plane: "member" },
          measured_at: "now",
        })
      if (path.endsWith("/workspaces/workspace"))
        return Response.json({
          workspace: {
            public_id: "workspace",
            name: "Workspace",
            access_mode: "private",
            state: "active",
            dedicated: false,
            lock_version: 0,
            created_at: "now",
            updated_at: "now",
            metadata: {},
            tool_provider_overrides: {},
            owner: { public_id: "human" },
            creator: { public_id: "human", kind: "human" },
          },
        })
      if (path.endsWith("/models"))
        return Response.json({
          models: [{ ref: "model", provider: "fixture", workload: "chat", available: true, visible: true }],
        })
      if (path.endsWith("/conversations") && request.method === "POST") {
        metadata.value = ((await request.json()) as { conversation: { metadata: JsonObject } }).conversation.metadata
        return Response.json({ conversation: conversationFixture({ metadata: metadata.value }) }, { status: 201 })
      }
      if (path.endsWith("/conversations/conversation")) {
        if (request.method === "PATCH")
          metadata.value = ((await request.json()) as { conversation: { metadata: JsonObject } }).conversation.metadata
        return Response.json({
          conversation: conversationFixture({
            metadata: metadata.value,
            ...(question.restored ? { active_turn_public_id: "turn" } : {}),
          }),
        })
      }
      if (path.endsWith("/turns/turn/variants"))
        return Response.json({
          turn: { public_id: "turn" },
          variants: [{ public_id: "variant", source: "model", status: "running", active: true, run_public_id: "run" }],
        })
      if (path.endsWith("/runs/run"))
        return Response.json({
          run: {
            public_id: "run",
            status: "needs_attention",
            tasks: [ask],
            attention: { reason: "awaiting_human", blocked_task_keys: ["ask"] },
          },
        })
      if (path.endsWith("/runs/run/tasks/ask")) return Response.json({ task: ask })
      if (path.endsWith("/events")) return Response.json({ events: [], pagination: { next_after: null, watermark: 0 } })
      if (question.restored && path.endsWith("/runs/run/transcript"))
        return Response.json({ rounds: [], pagination: { next_before: null, has_older: false } })
      if (path.endsWith("/turns/turn"))
        return Response.json({
          turn: {
            public_id: "turn",
            position: 1,
            kind: "dialog",
            role: "assistant",
            status: "completed",
            visibility: "visible",
            created_at: "now",
            answering_user_public_id: "main",
            active_variant: { public_id: "variant", source: "model", status: "completed", run_public_id: "run" },
          },
        })
      if (path.endsWith("/runs/run/transcript"))
        return Response.json({
          rounds: [
            {
              task_key: "r1",
              mainline: true,
              status: "completed",
              visibility: "visible",
              branches: [],
              calls: {
                count: 1,
                items: [{ task_key: "r1t1", name: "write", status: "completed", output_preview: "Wrote the file" }],
              },
            },
          ],
          pagination: { next_before: null, has_older: false },
        })
      if (path.endsWith("/runs/run/tasks/r1t1"))
        return Response.json({
          task: {
            key: "r1t1",
            kind: "tool_task",
            status: "completed",
            lifetime: "foreground",
            wake: "immediate",
            after: [],
            waiting_on: [],
            tool_name: "write",
            tool_input: { path: join(directory, "file"), content: "new" },
          },
        })
      if (path.endsWith("/history"))
        return Response.json({
          conversation: { public_id: "conversation", title: null },
          turns: [
            {
              public_id: "turn",
              position: 1,
              kind: "dialog",
              role: "assistant",
              status: "completed",
              created_at: "now",
              prompt: "User words",
              content: "Assistant words",
              steers: null,
              truncated: false,
            },
          ],
          pagination: { before_position: null, after_position: null, has_older: false, has_newer: false },
          truncated: false,
          execution: null,
        })

      return Response.json({ error: { code: "unexpected" } }, { status: 400 })
    },
  })
  const submitted: JsonObject[] = []
  const admissions = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
    if (path.endsWith("/inputs") && request.method === "POST") {
      expect(request.headers.get("authorization")).toBe("Bearer human")
      submitted.push(((await request.json()) as { input: JsonObject }).input)
      return Response.json({ error: { code: "response_lost" } }, { status: 503 })
    }
  })
  const application = new NexusApplication(
    admissions.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({ default_model: "model" }),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      async author(draft) {
        return { ...draft, lead: "Authored ACP instructions" }
      },
      async describeEnvironment() {
        return "Editor environment"
      },
      async follow() {},
      async bindings() {
        return []
      },
    },
  )
  const inbound = new TransformStream<AnyMessage>()
  const outbound = new TransformStream<AnyMessage>()
  const work = editor(
    { readable: inbound.readable, writable: outbound.writable },
    {
      state: "ready",
      origin: server.url.origin,
      directory,
      workspace: "workspace",
      model: "model",
      identity: { agent: "main", runner: "runner", workspace: "workspace", name: "Main", workspaceName: "Workspace" },
    },
    "fixture",
    {
      defaults: { mode: "bypass", model: "launch-model" },
      skills: async () => [
        { name: "project-guide", description: "Project guide" },
        { name: "retry", description: "Collision" },
      ],
      submit: async (input, signal) => {
        const receipt = await application.submit(
          { ...input, workspace: "workspace", principal: "human" },
          new Client({ baseURL: admissions.server.url.origin, credential: "human" }),
          { signal },
        )
        return receipt.input.public_id
      },
    },
  )
  const peer = client()
    .onNotification("session/update", ({ params }) => {
      updates.push(params)
      if (
        params.update.sessionUpdate === "agent_message_chunk" &&
        params.update.content.type === "text" &&
        params.update.content.text === "Continue?"
      )
        held.resolve()
    })
    .onRequest("elicitation/create", () => {
      expect(question.loaded).toBe(true)
      elicited.resolve()
      return answer.promise
    })
    .connect({ readable: outbound.readable, writable: inbound.writable })

  try {
    await peer.agent.request("initialize", { protocolVersion: 1 })
    await peer.agent.request("authenticate", { methodId: "nexus" })
    expect(await peer.agent.request("session/new", { cwd: directory, mcpServers: [] })).toMatchObject({
      sessionId: "conversation",
      modes: { currentModeId: "bypass" },
    })
    expect(metadata.value["opencode.acp.model"]).toBe("launch-model")
    const commands = updates.find((event) => event.update.sessionUpdate === "available_commands_update")!.update
    expect(commands).toMatchObject({
      availableCommands: [
        { name: "retry" },
        { name: "abandon" },
        { name: "compact" },
        { name: "project-guide", description: "Project guide" },
      ],
    })
    await expect(
      peer.agent.request("session/prompt", {
        sessionId: "conversation",
        prompt: [{ type: "text", text: "Use the runtime" }],
      }),
    ).rejects.toBeDefined()
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({
      inline: [{ role: "developer", position: "lead", text: "Authored ACP instructions" }],
      model: { model: "launch-model" },
      approval_mode: "bypass",
    })
    await peer.agent.request("session/set_mode", { sessionId: "conversation", modeId: "rules" })
    await peer.agent.request("session/close", { sessionId: "conversation" })
    updates.length = 0
    expect(
      await peer.agent.request("session/load", { sessionId: "conversation", cwd: directory, mcpServers: [] }),
    ).toMatchObject({ modes: { currentModeId: "rules" } })
    expect(updates.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "available_commands_update",
    ])
    expect(updates[1].update).toMatchObject({
      kind: "edit",
      rawInput: { content: "new" },
      content: [{ type: "diff", newText: "new" }],
    })
    await peer.agent.request("session/close", { sessionId: "conversation" })
    updates.length = 0
    await peer.agent.request("session/resume", { sessionId: "conversation", cwd: directory })
    expect(updates.map((event) => event.update.sessionUpdate)).toEqual(["available_commands_update"])
    await expect(
      peer.agent.request("session/set_mode", { sessionId: "conversation", modeId: "unknown" }),
    ).rejects.toMatchObject({ code: -32602 })
    await peer.agent.request("session/close", { sessionId: "conversation" })
    await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } })
    question.restored = true
    await peer.agent.request("session/resume", { sessionId: "conversation", cwd: directory })
    question.loaded = true
    await elicited.promise
    await expect(
      peer.agent.request("session/prompt", {
        sessionId: "conversation",
        prompt: [{ type: "text", text: "Concurrent prompt" }],
      }),
    ).rejects.toMatchObject({ code: -32600 })
    answer.resolve({ action: "cancel" })
    await held.promise
    await peer.agent.request("session/close", { sessionId: "conversation" })
    expect(calls.some((call) => call.endsWith("/cancellation"))).toBe(false)
  } finally {
    peer.close()
    await inbound.writable.close()
    await work
    server.stop(true)
    admissions.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("the editor bridge preserves unsaved contents, scopes filesystem requests and revokes closed sessions", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nexus-editor-fs-")))
  const outside = await realpath(await mkdtemp(join(tmpdir(), "nexus-editor-outside-")))
  const buffer = { content: "\ufeffunsaved\r\n" }
  const inbound = new TransformStream<AnyMessage>()
  const outbound = new TransformStream<AnyMessage>()
  const connection = agent().connect({ readable: inbound.readable, writable: outbound.writable })
  const peer = client()
    .onRequest("fs/read_text_file", () => ({ content: buffer.content }))
    .onRequest("fs/write_text_file", ({ params }) => {
      buffer.content = params.content
      return {}
    })
    .connect({ readable: outbound.readable, writable: inbound.writable })
  const bridge = await editorBridge()

  try {
    await writeFile(join(directory, "file"), "disk")
    await writeFile(join(outside, "private"), "private")
    if (process.platform !== "win32") await symlink(outside, join(directory, "escape"))

    const descriptor = bridge.attach("conversation", await editorRoots(directory), connection.client, {
      fs: { readTextFile: true, writeTextFile: true },
    })
    const request = (action: string, path: string, content?: string, token: string = descriptor.token) =>
      fetch(descriptor.url + action, {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ session: "conversation", path, content }),
      })

    expect(await (await request("/read", "file")).json()).toEqual({ content: "\ufeffunsaved\r\n" })
    expect((await request("/write", "file", "new unsaved")).status).toBe(200)
    expect(buffer.content).toBe("new unsaved")
    expect(await Bun.file(join(directory, "file")).text()).toBe("disk")
    expect((await request("/write", "new/nested/buffer", "unsaved nested")).status).toBe(200)
    expect(buffer.content).toBe("unsaved nested")
    expect(await Bun.file(join(directory, "new/nested/buffer")).exists()).toBe(false)
    expect((await request("/read", join(outside, "private"))).status).toBe(403)
    if (process.platform !== "win32") expect((await request("/read", "escape/private")).status).toBe(403)
    expect((await request("/read", "file", undefined, "wrong")).status).toBe(401)
    bridge.release("conversation")
    expect((await request("/read", "file")).status).toBe(410)
  } finally {
    await bridge.close()
    peer.close()
    connection.close()
    await rm(directory, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("ACP transcript keeps fallback message identities separate and does not duplicate settled output", async () => {
  const updates: SessionNotification[] = []
  const inbound = new TransformStream<AnyMessage>()
  const outbound = new TransformStream<AnyMessage>()
  const connection = agent().connect({ readable: inbound.readable, writable: outbound.writable })
  const peer = client()
    .onNotification("session/update", ({ params }) => {
      updates.push(params)
    })
    .connect({ readable: outbound.readable, writable: inbound.writable })
  const transcript = new EditorTranscript("conversation", connection.client)

  try {
    transcript.execution({ turn_public_id: "turn", variant_public_id: "v1", run_public_id: "r1" })
    await transcript.frame({
      type: "text_delta",
      turn_public_id: "turn",
      variant_public_id: "v1",
      run_public_id: "r1",
      task_key: null,
      turn: null,
      payload: { text: "hel" },
    })
    await transcript.settle("hello")
    await transcript.settle("hello")
    transcript.execution({ turn_public_id: "turn", variant_public_id: "v2", run_public_id: "r2" })
    await transcript.frame({
      type: "text_delta",
      turn_public_id: "turn",
      variant_public_id: "v1",
      run_public_id: "r1",
      task_key: null,
      turn: null,
      payload: { text: "stale" },
    })
    await transcript.settle("replacement")
    connection.close()
    peer.close()
    await peer.closed
    expect(updates.map((update) => update.update)).toMatchObject([
      { messageId: "turn:0", content: { text: "hel" } },
      { messageId: "turn:0", content: { text: "lo" } },
      { messageId: "turn:1", content: { text: "replacement" } },
    ])
  } finally {
    peer.close()
    connection.close()
  }
})

test("ACP prompt conversion retains embedded text and rejects unsupported audio before submission", async () => {
  const member = new Client({ baseURL: "http://127.0.0.1:1", credential: "unused" })
  const signal = new AbortController().signal

  expect(
    await editorPrompt(
      [
        { type: "text", text: "Read this" },
        { type: "resource", resource: { uri: "file:///notes", text: "Unsaved notes" } },
        { type: "resource_link", uri: "https://example.test", name: "Example", description: "Reference" },
      ],
      member,
      signal,
    ),
  ).toEqual({ text: "Read this\n\nfile:///notes\nUnsaved notes\n\nresource: https://example.test\nReference" })
  await expect(
    editorPrompt([{ type: "audio", data: "YQ==", mimeType: "audio/wav" }], member, signal),
  ).rejects.toMatchObject({ code: -32602 })
})
