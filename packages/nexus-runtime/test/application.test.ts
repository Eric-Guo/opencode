import { expect, test } from "bun:test"
import { Client, type JsonObject } from "@cybros/agent"
import { createHash } from "node:crypto"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { InputAdmissions } from "../src/admission"
import { presetInventory } from "../src/preset-mcp"
import { NexusApplication } from "../src/application"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture, turnFixture } from "./fixture/conversation"

test("a full profile releases legacy admissions and retries a locally prepared input after restart", async () => {
  await using directory = await tmpdir()
  const posted: { key: string | null; body: JsonObject }[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/profile/store_entries/0") && request.method === "DELETE" && fixture.entries.delete("0"))
      return Response.json({ error: { code: "response_lost" } }, { status: 503 })
    if (path.endsWith("/profile/store_entries") && request.method === "POST" && fixture.entries.size >= 64)
      return Response.json({ error: { code: "entry_limit_reached" } }, { status: 409 })
    if (path.endsWith("/inputs") && request.method === "POST") {
      const body = (await request.json()) as { input: JsonObject }
      posted.push({ key: request.headers.get("idempotency-key"), body: body.input })
      if (posted.length === 1) return Response.json({ error: { code: "response_lost" } }, { status: 503 })
      return Response.json(
        { input: inputFixture(body.input) },
        { status: 202, headers: { "Idempotency-Replayed": "true" } },
      )
    }
  })
  const open = () => new InputAdmissions(fixture.client, undefined, undefined, undefined, directory.path)
  const target = { workspace: "workspace", conversation: "conversation" }
  const attempt = { ...target, key: "retryable", request: { text: "Hello" } }
  const body = { kind: "direct_reply", text: "Hello", model: { model: "provider/original" } } as const
  const refusePreparation = async () => {
    throw new Error("Retry must use the saved declaration")
  }

  for (let index = 0; index < 64; index++) {
    const id = String(index)
    const admission = index < 45
    fixture.entries.set(id, {
      public_id: id,
      namespace: admission ? "opencode.input-admission" : "settings",
      key: admission ? createHash("sha256").update(`legacy-${id}`).digest("hex") : id,
      value: admission
        ? { request: attempt.request, target, body, input: `legacy-input-${id}`, notes: { legacy: id } }
        : { keep: id },
      lock_version: 1,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    })
  }

  try {
    await expect(open().capture(attempt, async () => body)).rejects.toMatchObject({
      status: 503,
      code: "response_lost",
    })
    expect(await open().capture(attempt, async () => body)).toEqual(body)
    expect([...fixture.entries.keys()]).toEqual(Array.from({ length: 19 }, (_, index) => String(index + 45)))
    expect(await open().notes(target.workspace, target.conversation, "legacy-input-0")).toEqual({ legacy: "0" })
    expect(await open().latestModel(target.workspace, target.conversation)).toBe("provider/original")
    expect(await open().capture({ ...attempt, key: "legacy-0" }, refusePreparation)).toEqual(body)

    await expect(open().submit(attempt, refusePreparation)).rejects.toMatchObject({
      status: 503,
      code: "response_lost",
    })
    expect(await open().submit(attempt, refusePreparation)).toMatchObject({
      input: { public_id: "input" },
      replayed: true,
    })
    expect(posted).toEqual([
      { key: "retryable", body },
      { key: "retryable", body },
    ])
    expect(fixture.state.writes).toBe(0)
  } finally {
    fixture.server.stop(true)
  }
})

test("Input admission freezes policy before POST and replays the same body after a lost response and restart", async () => {
  const submitted: { key: string; body: JsonObject }[] = []
  const fault = { lose: true }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
    if (path.endsWith("/inputs") && request.method === "POST") {
      const body = (await request.json()) as { input: JsonObject }
      submitted.push({ key: request.headers.get("idempotency-key")!, body: body.input })
      if (fault.lose) {
        fault.lose = false
        return Response.json({ error: { code: "response_lost" } }, { status: 503 })
      }
      return Response.json(
        {
          input: inputFixture(body.input),
        },
        { status: 202 },
      )
    }
  })
  const identity = { workspace: "workspace", agent: "main", runner: "runner" }
  const application = new NexusApplication(fixture.client, identity, () => ({ default_model: "provider/original" }))
  const request = { key: "accepted", workspace: "workspace", conversation: "conversation", text: "Inspect the project" }
  try {
    await expect(
      application.submit({
        ...request,
        preparation: async () => ({
          agent_configuration: { system_prompt: { content: "Original" } },
          model: "provider/original",
          fallback_models: ["provider/fallback"],
          tools: ["read"],
          executor_contexts: { runner: { "opencode.directory": "/captured" } },
        }),
      }),
    ).rejects.toThrow()
    expect(submitted).toHaveLength(1)
    const restored = new NexusApplication(
      fixture.client,
      identity,
      () => ({ default_model: "provider/changed" }),
      () => ({ runner: { "opencode.directory": "/next" } }),
    )
    const result = await restored.submit({
      ...request,
      preparation: async () => {
        throw new Error("Retry must use the saved declaration")
      },
    })
    expect(result.input.public_id).toBe("input")
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toEqual(submitted[0])
    expect(submitted[1].body).toMatchObject({
      agent_configuration: { system_prompt: { content: "Original" } },
      model: { model: "provider/original" },
      fallback_models: ["provider/fallback"],
      tool_names: ["read"],
      executor_contexts: { runner: { "opencode.directory": "/captured" } },
    })
    await expect(restored.submit({ ...request, text: "Different request" })).rejects.toThrow("another request")
    expect(submitted).toHaveLength(2)
    await restored.submit({ ...request, key: "fresh" })
    expect(submitted[2].body).toMatchObject({
      model: { model: "provider/changed" },
      executor_contexts: { runner: { "opencode.directory": "/next" } },
    })
  } finally {
    fixture.server.stop(true)
  }
})

test("Following recovers the requested input from HTTP after missing events and chooses its fallback chain", async () => {
  const paths: string[] = []
  const fixture = storeFixture((request) => {
    const path = new URL(request.url).pathname
    paths.push(path)
    if (path.endsWith("/events")) return Response.json({ events: [], pagination: { next_after: null, watermark: 0 } })
    if (path.endsWith("/inputs/accepted/materialization"))
      return Response.json({
        materialization: {
          input_public_id: "accepted",
          turn_public_id: "original",
          variant_public_id: "first",
          run_public_id: "run-first",
        },
      })
    if (path.endsWith("/turns/original/variants"))
      return Response.json({
        turn: { public_id: "original", inherited: false },
        variants: [
          {
            public_id: "unrelated",
            source: "regenerate",
            status: "completed",
            content: "Other reply",
            run_public_id: "other",
          },
          {
            public_id: "first",
            source: "original",
            status: "failed",
            content: "Discarded",
            run_public_id: "run-first",
          },
          {
            public_id: "fallback",
            source: "fallback",
            origin_variant_public_id: "first",
            status: "completed",
            content: "Recovered answer",
            run_public_id: "run-fallback",
          },
        ],
      })
    if (path.endsWith("/runs/run-fallback"))
      return Response.json({ run: { public_id: "run-fallback", status: "completed" } })
  })
  const app = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  try {
    const results = await Array.fromAsync(app.follow("workspace", "conversation", "accepted"))
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      content: "Recovered answer",
      terminal: true,
      execution: { variant_public_id: "fallback", turn_public_id: "original" },
    })
    expect(paths.some((path) => path.endsWith("/runs/other"))).toBe(false)
    const canceled = new AbortController()
    canceled.abort(new Error("stop following"))
    await expect(
      Array.fromAsync(app.follow("workspace", "conversation", "accepted", { signal: canceled.signal })),
    ).rejects.toThrow("stop following")
  } finally {
    fixture.server.stop(true)
  }
})

test("Mainline model inheritance follows settled execution while explicit choices and refreshed defaults retain precedence", async () => {
  const submitted: { key: string; body: JsonObject }[] = []
  const state = { settled: false, mainline: "provider/fallback", currentDefault: "provider/primary" }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
    if (path.endsWith("/turns")) {
      const before = new URL(request.url).searchParams.get("before_position")
      const history = state.settled
        ? Array.from({ length: 204 }, (_, position) =>
            position === 103
              ? turnFixture(position, {
                  public_id: "turn",
                  kind: "direct_reply",
                  active_variant: {
                    public_id: "variant",
                    source: "original",
                    status: "completed",
                    run_public_id: "run",
                    model: { provider_id: "provider", model_ref: "not-the-mainline" },
                  },
                })
              : turnFixture(position),
          )
        : []
      const turns = before
        ? history.filter((turn) => Number(turn.position) < Number(before)).slice(-100)
        : history.slice(0, 100)

      return Response.json({
        turns,
        pagination: {
          before_position: turns[0]?.position ?? null,
          after_position: turns.at(-1)?.position ?? null,
        },
      })
    }
    if (path.endsWith("/runs/run"))
      return Response.json({
        run: {
          public_id: "run",
          status: "completed",
          turn: {
            public_id: "turn",
            conversation_public_id: "conversation",
            status: "completed",
            model: { model: state.mainline },
          },
          tasks: [
            {
              key: "member",
              kind: "model_task",
              lifetime: "turn",
              wake: "auto",
              status: "completed",
              after: [],
              waiting_on: [],
              model: { model: "provider/task-only" },
            },
          ],
        },
      })
    if (path.endsWith("/inputs") && request.method === "POST") {
      const body = (await request.json()) as { input: JsonObject }
      const key = request.headers.get("idempotency-key")!
      submitted.push({ key, body: body.input })
      return Response.json({ input: inputFixture({ ...body.input, public_id: key }) }, { status: 202 })
    }
  })
  const open = () =>
    new NexusApplication(fixture.client, { workspace: "workspace", agent: "main", runner: "runner" }, () => ({
      default_model: state.currentDefault,
    }))
  const input = { workspace: "workspace", conversation: "conversation", text: "Continue" }
  try {
    const first = open()
    const catalog = await first.presets.catalog()
    const follow = catalog.presets.find((entry) => entry.configuration.model_mode === "follow")!
    await first.submit({ ...input, key: "first", preset: follow.public_id })
    expect(submitted.at(-1)?.body.model).toEqual({ model: "provider/primary" })
    state.settled = true
    await open().submit({ ...input, key: "settled", preset: follow.public_id })
    expect(submitted.at(-1)?.body.model).toEqual({ model: "provider/fallback" })
    state.mainline = "provider/primary"
    await open().submit({ ...input, key: "task-switch", preset: follow.public_id })
    expect(submitted.at(-1)?.body.model).toEqual({ model: "provider/primary" })
    state.currentDefault = "provider/new-default"
    await open().submit({ ...input, key: "default" })
    expect(submitted.at(-1)?.body.model).toEqual({ model: "provider/new-default" })
    const explicit = { ...input, key: "explicit", model: "provider/explicit" }
    await open().submit(explicit)
    state.mainline = "provider/fallback"
    await open().submit({ ...input, key: "explicit-follow", preset: follow.public_id })
    expect(submitted.at(-1)?.body).toMatchObject({
      model: { model: "provider/explicit" },
      model_selection: { source: "explicit", constraint: "route", model: "provider/explicit" },
    })
    await open().submit({ ...input, key: "new-choice", model: "provider/new-choice" })
    await open().submit(explicit)
    await open().submit({ ...input, key: "after-replay" })
    expect(submitted.at(-1)?.body.model).toEqual({ model: "provider/new-choice" })
  } finally {
    fixture.server.stop(true)
  }
})

test("prepared Human inputs retain authored policy through restart and never admit another request or principal", async () => {
  const posts: { authorization: string | null; body: JsonObject }[] = []
  const state = { authored: 0, refuse: false, lose: true }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
    if (path.endsWith("/inputs") && request.method === "POST") {
      posts.push({
        authorization: request.headers.get("authorization"),
        body: ((await request.json()) as { input: JsonObject }).input,
      })
      if (state.lose) {
        state.lose = false
        return Response.json({ error: { code: "response_lost" } }, { status: 503 })
      }
      return Response.json({ input: inputFixture() }, { status: 202 })
    }
  })
  const human = new Client({ baseURL: fixture.server.url.origin, credential: "human" })
  const open = () =>
    new NexusApplication(
      fixture.client,
      { workspace: "workspace", agent: "main", runner: "runner" },
      () => ({ default_model: "provider/model" }),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        async author(draft) {
          if (state.refuse) throw new Error("author refused")
          state.authored++
          return { ...draft, lead: "Captured author", notes: { captured: true } }
        },
        async describeEnvironment() {
          return "Environment"
        },
        async follow() {},
        async bindings() {
          return []
        },
      },
    )
  const input = {
    key: "human-input",
    principal: "human",
    workspace: "workspace",
    conversation: "conversation",
    text: "Inspect",
    delivery: "steer_now" as const,
    target: "original-run",
    approval: "ask" as const,
    attachments: ["upload"],
    preparation: async () => ({
      agent_configuration: { system_prompt: { content: "Original system" } },
      model: "provider/original",
      fallback_models: ["provider/fallback"],
      tools: ["read"],
      executor_contexts: { runner: { "opencode.directory": "/original" } },
    }),
  }
  try {
    state.refuse = true
    await expect(open().captureInput(input, human)).rejects.toThrow("author refused")
    expect(posts).toHaveLength(0)
    expect(
      [...fixture.entries.values()].filter((entry) => entry.namespace === "opencode.input-admission"),
    ).toHaveLength(0)
    state.refuse = false
    const prepared = await open().captureInput(input, human)
    expect(posts).toHaveLength(0)
    state.refuse = true
    const replay = {
      ...input,
      preparation: async () => {
        throw new Error("must use captured policy")
      },
    }
    expect(await open().captureInput(replay, human)).toEqual(prepared)
    await expect(open().submit(replay, human)).rejects.toThrow()
    await open().submit(replay, human)
    expect(state.authored).toBe(1)
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
    expect(posts[0].body).not.toHaveProperty("instructions")
    expect(posts[0]).toMatchObject({
      authorization: "Bearer human",
      body: {
        inline: [{ role: "developer", position: "lead", text: "Captured author" }],
        model: { model: "provider/original" },
        fallback_models: ["provider/fallback"],
        tool_names: ["read"],
        attachments: ["upload"],
        delivery_mode: "steer_now",
        expected_steering_run_public_id: "original-run",
        executor_contexts: { runner: { "opencode.directory": "/original" } },
      },
    })
    for (const patch of [
      { principal: "other" },
      { text: "Changed" },
      { conversation: "other" },
      { target: "other-run" },
    ])
      await expect(open().submit({ ...replay, ...patch }, human)).rejects.toThrow("another request")
    expect(posts).toHaveLength(2)
  } finally {
    fixture.server.stop(true)
  }
})

test.each([
  [422, "validation_failed", "Approval mode only tightens the declaring profile's approval mode"],
  [409, "idempotency_envelope_mismatch", "Mismatch"],
] as const)(
  "admission persists stricter approval after %s before an uncertain rules response",
  async (status, code, message) => {
    const modes: unknown[] = []
    const state = { lose: true }
    const fixture = storeFixture(async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
      if (path.endsWith("/inputs") && request.method === "POST") {
        const body = ((await request.json()) as { input: JsonObject }).input
        modes.push(body.approval_mode)
        if (body.approval_mode === "ask") return Response.json({ error: { code, message } }, { status })
        if (state.lose) {
          state.lose = false
          return Response.json({ error: { code: "lost" } }, { status: 503 })
        }
        return Response.json({ input: inputFixture() }, { status: 202 })
      }
    })
    const open = () =>
      new NexusApplication(fixture.client, { workspace: "workspace", agent: "main", runner: "runner" }, () => ({
        default_model: "model",
      }))
    const input = {
      key: "approval",
      workspace: "workspace",
      conversation: "conversation",
      text: "Hello",
      approval: "ask" as const,
    }
    try {
      await expect(open().submit(input)).rejects.toThrow()
      await open().submit(input)
      expect(modes).toEqual(["ask", "rules", "rules"])
    } finally {
      fixture.server.stop(true)
    }
  },
)

test("callable and canonical Preset names survive admission and a restricted role keeps its own selection", async () => {
  const bodies: JsonObject[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/tools"))
      return Response.json({
        tools: [
          { name: "memory_read", canonical_name: "nexus.memory.read", effect_profile: {}, definition: {} },
          { name: "memory_write", canonical_name: "nexus.memory.write", effect_profile: {}, definition: {} },
        ],
      })
    if (path.endsWith("/executors")) return Response.json({ executors: [] })
    if (path.endsWith("/mcp_connections"))
      return Response.json({ mcp_connections: [], pagination: { next_after: null } })
    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
    if (path.endsWith("/inputs") && request.method === "POST") {
      const body = (await request.json()) as { input: JsonObject }
      bodies.push(body.input)
      return Response.json({ input: inputFixture(body.input) }, { status: 202 })
    }
  })
  const identity = { agent: "main", runner: "runner", workspace: "workspace" }
  const base = { default_model: "provider/model", kernel_tools: ["nexus.memory.read", "nexus.memory.write"] }
  const application = new NexusApplication(
    fixture.client,
    identity,
    () => base,
    undefined,
    undefined,
    undefined,
    () => presetInventory(fixture.client, identity, [], base),
  )
  try {
    const choices = await application.presets.command({ action: "preset.tools" })
    expect(choices).toMatchObject({
      tools: [{ name: "memory_read", canonical: "nexus.memory.read" }, { name: "memory_write" }],
    })
    expect(fixture.state.writes).toBe(0)
    const catalog = await application.presets.catalog()
    const parent = catalog.presets.find((entry) => entry.public_id === catalog.main_preset_public_id)!
    const role = catalog.presets.find((entry) => entry.role?.name === "worker")!
    await application.presets.command({
      action: "preset.replace",
      id: role.public_id,
      value: { ...role, configuration: { tools: ["nexus.memory.write"] } },
    })
    await application.presets.command({
      action: "preset.replace",
      id: parent.public_id,
      value: { ...parent, configuration: { tools: ["memory_read"] } },
    })
    const input = { workspace: "workspace", conversation: "conversation", key: "original", text: "Read memory" }
    await application.submit(input)
    expect(bodies[0].agent_configuration).toMatchObject({
      kernel_tools: ["nexus.memory.read"],
      delegation_catalog: expect.arrayContaining([
        expect.objectContaining({
          name: "worker",
          declaration: expect.objectContaining({ kernel_tools: ["nexus.memory.write"] }),
        }),
      ]),
    })
    await application.presets.command({
      action: "preset.replace",
      id: parent.public_id,
      value: { ...parent, configuration: { tools: [] } },
    })
    await application.submit({ ...input, key: "new" })
    expect(bodies.at(-1)?.agent_configuration).toMatchObject({ kernel_tools: [] })
    await application.submit(input)
    expect(bodies[0].agent_configuration).toMatchObject({ kernel_tools: ["nexus.memory.read"] })
    expect(bodies.at(-1)?.agent_configuration).toEqual(bodies[0].agent_configuration)
  } finally {
    fixture.server.stop(true)
  }
})
