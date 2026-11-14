import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import type { JsonObject } from "@cybros/agent"
import { ExtensionManager } from "../src/extension-manager"
import { TurnDraft, type ExtensionLifecycle } from "../src/extension-lifecycle"
import { Configuration } from "../src/configuration"
import { NexusApplication } from "../src/application"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture } from "./fixture/conversation"

const descriptor = {
  id: "fixture",
  name: "Fixture",
  description: "Lifecycle fixture",
  configuration_version: 1,
  default_enabled: true,
  configuration_schema: { type: "object", properties: { version: { type: "integer" } }, additionalProperties: false },
  defaults: { version: 1 },
} as const
const draft = { body: { text: "original" }, lead: "original lead", environment: {}, notes: {}, tools: [] }

test("Extension authoring is ordered and fail-closed, while observers and binding projections fail independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-lifecycle-"))
  const calls: string[] = []
  const state = { refuse: false }
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [
      {
        descriptor,
        register(api) {
          api.on("turn.author", (raw) => {
            calls.push("first")
            const value = Schema.decodeUnknownSync(TurnDraft)(raw)
            return { ...value, lead: value.lead + " + first", notes: { fixture: { captured: true } } }
          })
          api.on("turn.author", () => {
            throw new Error("author failure")
          })
          api.on("host.ended", () => {
            throw new Error("observer failure")
          })
          api.on("conversation.binding", () => ({ source: "fixture", read_only: true }))
          api.describeEnvironment(() => "Fixture environment")
        },
      },
      {
        descriptor: { ...descriptor, id: "second" },
        register(api) {
          api.on("turn.author", (raw) => {
            calls.push("second")
            return state.refuse ? { refused: true, reason: "refused" } : raw
          })
          api.on("host.ended", () => {
            calls.push("ended")
          })
          api.on("conversation.binding", () => {
            throw new Error("binding failure")
          })
          api.describeEnvironment(() => {
            throw new Error("description failure")
          })
        },
      },
    ],
    directory,
    new AbortController().signal,
    async () => {},
  )
  try {
    await manager.start()
    await expect(manager.author(draft)).rejects.toThrow("author failure")
    expect(calls).toEqual(["first"])
    await manager.emit("host.ended", { conversation: "conversation" })
    expect(calls).toEqual(["first", "ended"])
    expect(await manager.bindings({ workspace: "workspace", conversation: "conversation" })).toEqual([
      { source: "fixture", read_only: true },
    ])
    expect(await manager.describeEnvironment({ root: directory })).toBe("Fixture environment")
  } finally {
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("Extension follow gates retain their owning instance until cancellation and first gate wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-gate-"))
  const released: number[] = []
  const reconsidered: number[] = []
  const canceled: string[] = []
  const published = Promise.withResolvers<void>()
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [
      {
        descriptor,
        register(api) {
          const version = Number(api.configuration.version)
          api.on("turn.follow", () => ({
            reconsider() {
              reconsidered.push(version)
            },
            cancel() {
              canceled.push("first")
            },
          }))
          api.onShutdown(() => {
            released.push(version)
          })
        },
      },
      {
        descriptor: { ...descriptor, id: "second" },
        register(api) {
          api.on("turn.follow", () => ({
            reconsider() {
              throw new Error("must not run")
            },
            cancel() {
              canceled.push("second")
            },
          }))
        },
      },
    ],
    directory,
    new AbortController().signal,
    async () => {
      published.resolve()
    },
  )
  const context = { workspace: "workspace", conversation: "conversation", run: "run", turn: "turn", notes: {} }
  try {
    await manager.start()
    const gate = await manager.follow(context)
    expect(canceled).toEqual(["second"])
    await manager.change({ id: "fixture", operations: [{ op: "set", path: ["version"], value: 2 }] })
    await published.promise
    expect(released).toEqual([])
    await gate?.reconsider({
      ...context,
      signal: new AbortController().signal,
      snapshot: {
        execution: { turn_public_id: "turn", variant_public_id: "variant", run_public_id: "run" },
        variant: null,
        status: "running",
        run_status: "running",
        attention: null,
        failure_reason: null,
        failure_reason_key: null,
        needs_attention: false,
        content: null,
        terminal: false,
      },
    })
    expect(reconsidered).toEqual([1])
    await gate?.cancel?.()
    await manager.close()
    expect(released.toSorted()).toEqual([1, 2])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Until authoring and hook notes survive lost admission without re-authoring or orphaning refused policy", async () => {
  const posts: JsonObject[] = []
  const state = { lose: true, author: 0 }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/conversations/conversation"))
      return Response.json({
        conversation: conversationFixture({
          default_runner: { executor_public_id: "runner", display_name: "Fixture", presence: "online" },
        }),
      })
    if (path.endsWith("/turns"))
      return Response.json({ turns: [], pagination: { before_position: null, after_position: null } })
    if (path.endsWith("/tools/assembly")) return Response.json({ tool_definitions: [], environment: {} })
    if (path.endsWith("/inputs") && request.method === "POST") {
      posts.push(((await request.json()) as { input: JsonObject }).input)
      if (state.lose) {
        state.lose = false
        return Response.json({ error: { code: "lost" } }, { status: 503 })
      }
      return Response.json({ input: inputFixture() }, { status: 202 })
    }
  })
  const hooks: ExtensionLifecycle = {
    async author(draft) {
      state.author++
      return {
        ...draft,
        lead: draft.lead + "\nCaptured author lead",
        notes: { ...draft.notes, fixture: { original: true } },
      }
    },
    async follow() {},
    async bindings() {
      return []
    },
    async describeEnvironment() {
      return "Captured environment"
    },
  }
  const open = (lifecycle: ExtensionLifecycle) =>
    new NexusApplication(
      fixture.client,
      { agent: "main", runner: "runner", workspace: "workspace" },
      () => ({ default_model: "provider/model", system_prompt: { content: "Original system prompt" } }),
      () => ({ runner: { "opencode.directory": "/captured" } }),
      undefined,
      undefined,
      undefined,
      lifecycle,
    )
  const input = {
    key: "request",
    workspace: "workspace",
    conversation: "conversation",
    text: "Implement",
    until: { command: "bun test", attempts: 3 },
    preparation: async () => ({
      agent_configuration: { system_prompt: { content: "Original system prompt" } },
      model: "provider/model",
      fallback_models: [],
    }),
  }
  try {
    await expect(
      open({
        ...hooks,
        async author() {
          throw new Error("refused")
        },
      }).submit(input),
    ).rejects.toThrow("refused")
    expect(
      [...fixture.entries.values()].filter((row) => row.namespace === "opencode.nexus" && row.key === "until"),
    ).toHaveLength(0)
    expect(posts).toHaveLength(0)
    await expect(open(hooks).submit(input)).rejects.toThrow()
    const saved = [...fixture.entries.values()].find(
      (row) => row.namespace === "opencode.nexus" && row.key === "until",
    )!
    const value = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(saved.value)
    fixture.entries.set(saved.public_id, {
      ...saved,
      value: { ...value, run: "original-run" },
      lock_version: saved.lock_version + 1,
    })
    await open({
      ...hooks,
      async author() {
        throw new Error("must not re-author")
      },
    }).submit(input)
    expect(state.author).toBe(1)
    expect(posts[1]).toEqual(posts[0])
    expect(posts[1].steps).toHaveLength(2)
    expect(posts[1].instructions).toContain("Captured author lead")
    const current = fixture.entries.get(saved.public_id)!
    expect(current.value).toHaveProperty("run", "original-run")
    expect(current.value).toHaveProperty("policy.seed.instructions", expect.stringContaining("Original system prompt"))
  } finally {
    fixture.server.stop(true)
  }
})

test("Turn settlement observes completed work without memory review and releases a missing host once", async () => {
  const state = { status: "running", gone: false, followed: 0, reconsidered: 0, canceled: 0 }
  const notifications: string[] = []
  const settlement = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const turn = () => ({
    public_id: "turn",
    input_public_id: "input",
    position: 1,
    kind: "direct_reply",
    role: "assistant",
    status: state.status,
    visibility: "visible",
    inherited: false,
    reference: false,
    created_at: "2026-01-01T00:00:00Z",
    answering_user_public_id: "main",
    active_variant: {
      public_id: "variant",
      source: "original",
      status: state.status,
      content: "The answer",
      run_public_id: "run",
    },
  })
  const fixture = storeFixture((request) => {
    const url = new URL(request.url)
    const path = url.pathname
    if (path.endsWith("/profile/agents")) return Response.json({ agents: [] })
    if (path.endsWith("/conversations"))
      return Response.json({ conversations: [conversationFixture()], pagination: { next_after: null } })
    if (path.endsWith("/turns"))
      return state.gone
        ? Response.json({ error: { code: "not_found" } }, { status: 404 })
        : Response.json({
            turns: Number(url.searchParams.get("after_position")) < 1 ? [turn()] : [],
            pagination: { before_position: null, after_position: null },
          })
    if (path.endsWith("/turns/turn")) return Response.json({ turn: turn() })
    if (path.endsWith("/turns/turn/variants"))
      return Response.json({ turn: { public_id: "turn", inherited: false }, variants: [turn().active_variant] })
    if (path.endsWith("/events")) return Response.json({ events: [], pagination: { next_after: null, watermark: 0 } })
    if (path.endsWith("/runs/run")) return Response.json({ run: { public_id: "run", status: state.status } })
  })
  const app = new NexusApplication(
    fixture.client,
    { agent: "main", runner: "runner", workspace: "workspace" },
    () => ({}),
    undefined,
    undefined,
    async (name) => {
      notifications.push(name)
      if (name === "turn.settled") {
        settlement.resolve()
        await release.promise
      }
    },
    undefined,
    {
      async author(value) {
        return value
      },
      async bindings() {
        return []
      },
      async describeEnvironment() {
        return ""
      },
      async follow() {
        state.followed++
        return {
          reconsider() {
            state.reconsidered++
          },
          cancel() {
            state.canceled++
          },
        }
      },
    },
  )
  try {
    await app.lifecycle.tick(AbortSignal.timeout(2000))
    state.status = "completed"
    await app.lifecycle.tick(AbortSignal.timeout(2000))
    await settlement.promise
    await app.lifecycle.tick(AbortSignal.timeout(2000))
    expect(notifications).toEqual(["turn.settled"])
    expect(state.followed).toBe(1)
    expect(state.reconsidered).toBe(3)
    state.gone = true
    await app.lifecycle.tick(AbortSignal.timeout(2000))
    await app.lifecycle.tick(AbortSignal.timeout(2000))
    expect(notifications).toEqual(["turn.settled", "host.ended"])
    expect(state.canceled).toBe(1)
  } finally {
    release.resolve()
    fixture.server.stop(true)
  }
})
