import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { MemoryReview, renderReview } from "../src/memory-review"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture } from "./fixture/conversation"

function fixture() {
  const binding = {
    name: "speaker",
    source: { scope: "speaker" },
    scope: "speaker",
    access: "read_write",
    collection_public_id: "collection",
    owner_public_id: "human",
    speaker_public_id: "human",
    state: "active",
  }
  const captured = {
    bindings: [
      {
        name: binding.name,
        source: binding.source,
        access: binding.access,
        capture: {
          collection_public_id: binding.collection_public_id,
          owner_public_id: binding.owner_public_id,
          scope: binding.scope,
          speaker_public_id: binding.speaker_public_id,
        },
      },
    ],
  }
  const turn = {
    public_id: "turn",
    input_public_id: "source-input",
    position: 0,
    kind: "direct_reply",
    role: "assistant",
    status: "completed",
    visibility: "visible",
    inherited: false,
    created_at: "2026-11-15T00:00:00Z",
    answering_user_public_id: "main",
    active_variant: {
      public_id: "variant",
      source: "original",
      status: "completed",
      active: true,
      content: "Verified preference",
      prompt_text: "Remember preference",
      run_public_id: "run",
      model: { provider_id: "provider", model_ref: "model" },
      memory_context: captured,
    },
  }
  const state = {
    document: null as JsonObject | null,
    lost: false,
    completed: false,
    writes: 0,
    forks: [] as string[],
    submissions: [] as { key: string; body: JsonObject }[],
  }
  const server = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    if (path.includes("/store_entries")) return
    if (path.endsWith("/memory") && request.method === "GET")
      return Response.json({ memory_context: { bindings: [binding] } })
    if (path.endsWith("/memory/show"))
      return state.document
        ? Response.json({ memory: state.document })
        : Response.json({ error: { code: "memory_not_found" } }, { status: 404 })
    if (path.endsWith("/memory") && request.method === "POST") {
      const input = (await request.json()) as { memory: JsonObject }
      if (
        input.memory.expected_public_id !== (state.document?.public_id ?? null) ||
        input.memory.expected_lock_version !== (state.document?.lock_version ?? null)
      )
        return Response.json({ error: { code: "stale_object" } }, { status: 409 })
      state.writes++
      state.document = {
        public_id: "document",
        collection_public_id: "collection",
        lock_version: state.writes - 1,
        path: input.memory.path,
        content: input.memory.content,
        bytesize: Buffer.byteLength(String(input.memory.content)),
        written_at: new Date().toISOString(),
      }
      return Response.json({ memory: state.document }, { status: 201 })
    }
    if (path.endsWith("/forks")) {
      state.forks.push(request.headers.get("idempotency-key")!)
      if (state.lost) {
        state.lost = false
        return Response.json({ error: { code: "response_lost" } }, { status: 503 })
      }
      return Response.json(
        {
          conversation: conversationFixture({ public_id: "review", side: true }),
          runner_effects: { status: "untouched", runners: [] },
        },
        { status: 201 },
      )
    }
    if (path.endsWith("/inputs") && request.method === "POST") {
      const body = (await request.json()) as { input: JsonObject }
      state.submissions.push({ key: request.headers.get("idempotency-key")!, body: body.input })
      return Response.json({ input: inputFixture({ public_id: "review-input" }) }, { status: 202 })
    }
    if (path.endsWith("/materialization"))
      return Response.json({
        materialization: {
          input_public_id: "review-input",
          turn_public_id: "review-turn",
          variant_public_id: "review-variant",
          run_public_id: "review-run",
        },
      })
    if (path.endsWith("/turns/review-turn"))
      return Response.json({
        turn: {
          ...turn,
          public_id: "review-turn",
          status: state.completed ? "completed" : "running",
          active_variant: {
            ...turn.active_variant,
            public_id: "review-variant",
            run_public_id: "review-run",
            content: JSON.stringify({
              content: "# Memory\nPrefers concise answers.",
              summary: "Recorded a confirmed communication preference.",
            }),
          },
        },
      })
    if (path.endsWith("/turns/turn")) return Response.json({ turn })
    if (path.endsWith("/turns"))
      return Response.json({ turns: [turn], pagination: { before_position: null, after_position: null } })
    if (path.endsWith("/conversations/conversation"))
      return Response.json({
        conversation: conversationFixture({ memory_context: null, effective_memory_context: { bindings: [binding] } }),
      })
    return Response.json({ error: { code: "not_found", message: path } }, { status: 404 })
  })
  return { ...server, state, turn, binding }
}

test("memory review recovers the same private fork and writes once against the captured document version", async () => {
  const value = fixture()
  const review = new MemoryReview(value.client, "workspace", "conversation")
  try {
    await review.enable("speaker/review.md", undefined, -1, "human")
    value.state.lost = true
    const turn = await value.client.workspace("workspace").conversation("conversation").turns.fetch("turn")
    await expect(review.settled(turn)).rejects.toThrow()
    const restored = new MemoryReview(value.client, "workspace", "conversation")
    expect(await restored.resume()).toMatchObject({ pending: true })
    expect(value.state.forks).toHaveLength(2)
    expect(value.state.forks[0]).toBe(value.state.forks[1])
    expect(value.state.submissions[0].body).toMatchObject({
      tool_names: [],
      context_mode: "raw",
      visible_in_context: false,
      model: { model: "provider/model" },
    })
    value.state.completed = true
    expect(await restored.resume()).toMatchObject({ pending: false, outcome: "updated", run_public_id: "review-run" })
    expect(value.state.document?.content).toContain("Source: conversation conversation; turn turn; run run.")
    await restored.resume()
    expect(value.state.writes).toBe(2)
    expect(value.state.submissions).toHaveLength(1)
  } finally {
    value.server.stop(true)
  }
})

test("a memory proposal cannot overwrite an edited document or recreate a deleted destination", async () => {
  const value = fixture()
  const review = new MemoryReview(value.client, "workspace", "conversation")
  try {
    await review.enable("speaker/review.md", undefined, -1, "human")
    await review.settled(await value.client.workspace("workspace").conversation("conversation").turns.fetch("turn"))
    value.state.document = { ...value.state.document!, lock_version: 5, content: "Newer correction" }
    value.state.completed = true
    expect(await review.resume()).toMatchObject({ outcome: "skipped", pending: false })
    expect(value.state.document.content).toBe("Newer correction")
    expect(value.state.writes).toBe(1)
    value.state.document = null
    await review.settled({
      ...(await value.client.workspace("workspace").conversation("conversation").turns.fetch("turn")),
      position: 1,
    })
    expect(value.state.document).toBeNull()
    expect(value.state.writes).toBe(1)
  } finally {
    value.server.stop(true)
  }
})

test("memory review consolidates completed turns on the configured cadence", async () => {
  const value = fixture()
  const review = new MemoryReview(value.client, "workspace", "conversation")
  try {
    await review.enable("speaker/review.md", undefined, -1, "human")
    const turn = await value.client.workspace("workspace").conversation("conversation").turns.fetch("turn")
    for (const position of [0, 1, 2, 3]) await review.settled({ ...turn, position }, 5)
    expect(value.state.forks).toHaveLength(0)
    await review.settled({ ...turn, position: 4 }, 5)
    expect(value.state.forks).toHaveLength(1)
    await review.settled({ ...turn, position: 5 }, 5)
    expect(value.state.forks).toHaveLength(1)
  } finally {
    value.server.stop(true)
  }
})

test("review output bounds include source references and count UTF-8 bytes", () => {
  const source = { conversation: "conversation", turn: "turn", run: "run", date: "2026-11-15" }
  expect(renderReview({ content: "x".repeat(6144), summary: "summary" }, source)).toBeUndefined()
  expect(renderReview({ content: "notes", summary: "😀".repeat(193) }, source)).toBeUndefined()
  expect(renderReview({ content: "secret\0", summary: "" }, source)).toBeUndefined()
  expect(renderReview({ content: "notes\n", summary: "" }, source)).toBe("notes\n")
})
