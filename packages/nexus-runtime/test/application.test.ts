import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture } from "./fixture/conversation"

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
    if (path.endsWith("/turns"))
      return Response.json({
        turns: state.settled
          ? [
              {
                public_id: "turn",
                input_public_id: "first",
                position: 1,
                kind: "direct_reply",
                role: "assistant",
                status: "completed",
                visibility: "visible",
                created_at: "2026-01-01T00:00:00Z",
                answering_user_public_id: "main",
                active_variant: {
                  public_id: "variant",
                  source: "original",
                  status: "completed",
                  run_public_id: "run",
                  model: { provider_id: "provider", model_ref: "not-the-mainline" },
                },
              },
            ]
          : [],
        pagination: { before_position: null, after_position: null },
      })
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
