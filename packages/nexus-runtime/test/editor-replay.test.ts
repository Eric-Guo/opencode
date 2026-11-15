import { expect, test } from "bun:test"
import type { JsonObject } from "@cybros/agent"
import { editorFixture } from "./fixture/editor"

const turns: JsonObject[] = [
  {
    public_id: "reference",
    position: 1,
    kind: "direct_reply",
    role: "assistant",
    reference: true,
    prompt: "Parent seed",
    content: "Frozen parent context",
  },
  {
    public_id: "inherited",
    position: 2,
    kind: "direct_reply",
    role: "assistant",
    inherited: true,
    prompt: "Inherited prompt",
    content: "Inherited answer",
  },
  { public_id: "summary", position: 3, kind: "compaction_summary", role: "assistant", content: "Internal summary" },
  { public_id: "message", position: 4, kind: "message", role: "user", content: "Human message" },
  {
    public_id: "reply",
    position: 5,
    kind: "direct_reply",
    role: "assistant",
    prompt: "Prompt preview",
    content: "Answer preview",
    truncated: true,
  },
]

test("ACP replays paginated history by role, emits one Side context and skips summaries", async () => {
  const transcripts: string[] = []
  await using fixture = await editorFixture((request) => {
    const url = new URL(request.url)
    const id = url.pathname.split("/").at(-1)

    if (id === "history")
      return Response.json({
        conversation: { public_id: "conversation", title: null },
        turns: (url.searchParams.has("before_position") ? turns.slice(0, 2) : turns.slice(2)).map((turn) => ({
          status: "completed",
          created_at: "now",
          truncated: false,
          ...turn,
        })),
        pagination: { has_older: !url.searchParams.has("before_position"), before_position: 3, has_newer: false },
        truncated: false,
      })
    const turn = turns.find((turn) => turn.public_id === id)

    if (turn)
      return Response.json({
        turn: {
          status: "completed",
          visibility: "visible",
          created_at: "now",
          answering_user_public_id: "main",
          ...turn,
          active_variant: {
            public_id: "variant-" + id,
            source: "run",
            status: "completed",
            active: true,
            run_public_id: id === "reference" ? "parent" : null,
          },
        },
      })
    if (url.pathname.endsWith("/fields/prompt") || url.pathname.endsWith("/fields/content")) {
      const field = url.pathname.endsWith("prompt") ? "Prompt" : "Answer"
      return Response.json({
        conversation_public_id: "conversation",
        turn_public_id: "reply",
        variant_public_id: "variant-reply",
        field: field.toLowerCase(),
        inherited: false,
        text: url.searchParams.has("after") ? " complete" : field,
        pagination: { next_after: url.searchParams.has("after") ? null : "next" },
      })
    }
    if (url.pathname.endsWith("/transcript")) transcripts.push(url.pathname)
  })

  await fixture.attach()
  expect(
    fixture.updates.flatMap(({ update }) =>
      update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "user_message_chunk"
        ? [{ type: update.sessionUpdate, id: update.messageId, content: update.content }]
        : [],
    ),
  ).toEqual([
    {
      type: "user_message_chunk",
      id: "reference:reference",
      content: {
        type: "text",
        text: "Parent conversation reference snapshot (context only):\n\nFrozen parent context",
      },
    },
    { type: "user_message_chunk", id: "inherited:0", content: { type: "text", text: "Inherited prompt" } },
    { type: "agent_message_chunk", id: "inherited:0", content: { type: "text", text: "Inherited answer" } },
    { type: "user_message_chunk", id: "message:0", content: { type: "text", text: "Human message" } },
    { type: "user_message_chunk", id: "reply:0", content: { type: "text", text: "Prompt complete" } },
    { type: "agent_message_chunk", id: "reply:0", content: { type: "text", text: "Answer complete" } },
  ])
  expect(transcripts).toEqual([])
  expect(fixture.requests.some((request) => request.endsWith("/turns/summary"))).toBe(false)
})

test.each(["session/load", "session/resume"] as const)(
  "ACP %s never adopts an inherited execution or reference",
  async (method) => {
    await using fixture = await editorFixture((request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/history"))
        return Response.json({
          conversation: { public_id: "conversation", title: null },
          turns: turns
            .slice(0, 3)
            .map((turn) => ({ status: "completed", created_at: "now", truncated: false, ...turn })),
          pagination: { has_older: false, has_newer: false },
          truncated: false,
        })
      const turn = turns.find((turn) => path.endsWith("/turns/" + turn.public_id))
      if (turn)
        return Response.json({
          turn: {
            status: "failed",
            visibility: "visible",
            created_at: "now",
            answering_user_public_id: "main",
            ...turn,
            active_variant: {
              public_id: "parent-variant",
              source: "run",
              active: true,
              status: "failed",
              run_public_id: "parent",
            },
          },
        })
    })
    await fixture.attach(method)
    if (method === "session/resume")
      expect(fixture.requests.some((request) => request.endsWith("/history"))).toBe(false)
    await expect(fixture.prompt("/abandon")).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("no holding task"),
    })
    expect(
      fixture.requests.some((request) => request.includes("/runs/parent") && !request.endsWith("/transcript")),
    ).toBe(false)
    if (method === "session/resume") expect(fixture.updates).toHaveLength(1)
  },
)

test.each([
  { method: "session/load", command: "/abandon" },
  { method: "session/resume", command: "/abandon" },
  { method: "session/load", command: "/retry" },
  { method: "session/resume", command: "/retry" },
] as const)(
  "ACP $method recovers $command without an active pointer and selects the running variant",
  async ({ method, command }) => {
    const state = { retried: false }
    const task = {
      key: "step",
      kind: "llm_task",
      status: "failed",
      lifetime: "foreground",
      wake: "immediate",
      after: [],
      waiting_on: [],
    }
    const variant = () => ({
      public_id: "running",
      active: false,
      source: "run",
      status: state.retried ? "completed" : "failed",
      run_public_id: "owned",
      content: state.retried ? "Recovered answer" : "",
    })
    await using fixture = await editorFixture((request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/history"))
        return Response.json({
          conversation: { public_id: "conversation", title: null },
          turns: [
            {
              public_id: "turn",
              position: 1,
              kind: "direct_reply",
              role: "assistant",
              status: "failed",
              created_at: "now",
              prompt: "Work",
              content: "Old answer",
              truncated: false,
            },
          ],
          pagination: { has_older: false, has_newer: false },
          truncated: false,
        })
      if (path.endsWith("/turns/turn"))
        return Response.json({
          turn: {
            public_id: "turn",
            position: 1,
            kind: "direct_reply",
            role: "assistant",
            status: "failed",
            visibility: "visible",
            created_at: "now",
            answering_user_public_id: "main",
            active_variant: { ...variant(), public_id: "settled", status: "completed", run_public_id: "old" },
            running_variant: variant(),
          },
        })
      if (path.endsWith("/turns/turn/variants"))
        return Response.json({ turn: { public_id: "turn" }, variants: [variant()] })
      if (path.endsWith("/runs/owned"))
        return Response.json({
          run: {
            public_id: "owned",
            status: state.retried ? "completed" : "needs_attention",
            tasks: state.retried ? [] : [task],
          },
        })
      if (path.endsWith("/tasks/step/abandon") || path.endsWith("/tasks/step/retry")) {
        state.retried = true
        return Response.json({ task: { ...task, status: "completed" } })
      }
    })
    await fixture.attach(method)
    if (method === "session/resume")
      expect(fixture.requests.some((request) => request.endsWith("/history"))).toBe(false)
    expect(await fixture.prompt(command)).toEqual({ stopReason: "end_turn" })
    expect(fixture.requests).toContain(
      "POST /agent_api/v1/workspaces/workspace/runs/owned/tasks/step/" + command.slice(1),
    )
    expect(fixture.requests.some((request) => request.includes("/runs/old") && !request.endsWith("/transcript"))).toBe(
      false,
    )
    if (method === "session/resume" && command === "/abandon") expect(fixture.updates).toHaveLength(1)
    if (command === "/retry")
      expect(fixture.updates).toContainEqual({
        sessionId: "conversation",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "turn:0",
          content: { type: "text", text: "Recovered answer" },
        },
      })
  },
)
