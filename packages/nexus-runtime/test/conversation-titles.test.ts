import { expect, test } from "bun:test"
import { ConversationTitles } from "../src/conversation-titles"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture } from "./fixture/conversation"

for (const mode of ["follow_current", "lane/title-model", "unicode", "none", "manual", "failed", "shutdown"])
  test("conversation titles respect " + mode + " and consume one durable attempt", async () => {
    const control = { title: "", forks: 0, removed: 0, patches: 0 }
    const generating = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const fixture = storeFixture(async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/conversations/main")) {
        if (request.method === "PATCH") {
          const body = (await request.json()) as { conversation: { title: string } }
          control.title = body.conversation.title
          control.patches++
        }
        return Response.json({
          conversation: conversationFixture({
            public_id: "main",
            title: control.title,
            metadata: { "opencode.title_pending": true },
          }),
        })
      }
      if (path.endsWith("/forks")) {
        control.forks++
        return Response.json(
          {
            conversation: conversationFixture({ public_id: "side", side: true }),
            runner_effects: { status: "untouched", runners: [] },
          },
          { status: 201 },
        )
      }
      if (path.endsWith("/conversations/side") && request.method === "DELETE") {
        control.removed++
        return new Response(null, { status: 204 })
      }
      if (path.endsWith("/inputs") && request.method === "POST") {
        const body = (await request.json()) as {
          input: { context_mode: string; tool_names: string[]; text: string; model: { model: string } }
        }
        expect(body.input).toMatchObject({
          context_mode: "raw",
          tool_names: [],
          model: { model: mode === "lane/title-model" ? mode : "lane/current" },
        })
        expect(Array.from(body.input.text)).toHaveLength(4000)
        expect(body.input.text.isWellFormed()).toBe(true)
        if (mode === "unicode") expect(body.input.text).toBe("x".repeat(3999) + "😀")
        return Response.json({ input: inputFixture() }, { status: 202 })
      }
      if (path.endsWith("/events")) return Response.json({ events: [], pagination: { next_after: null, watermark: 0 } })
      if (path.endsWith("/materialization"))
        return Response.json({
          materialization: {
            input_public_id: "input",
            turn_public_id: "turn",
            variant_public_id: "variant",
            run_public_id: "run",
          },
        })
      if (path.endsWith("/variants")) {
        generating.resolve()
        if (mode === "manual" || mode === "shutdown") await release.promise
        return Response.json({
          turn: { public_id: "turn", inherited: false },
          variants: [
            {
              public_id: "variant",
              source: "original",
              status: mode === "failed" ? "failed" : "completed",
              content:
                mode === "unicode"
                  ? '"' + "x".repeat(254) + '😀 extra"\nUnwanted line'
                  : '"A useful title"\nUnwanted line',
              run_public_id: "run",
            },
          ],
        })
      }
      if (path.endsWith("/runs/run")) return Response.json({ run: { public_id: "run", status: "completed" } })
    })
    const titles = new ConversationTitles(fixture.client, () =>
      mode === "none" ? null : mode === "lane/title-model" ? mode : "follow_current",
    )
    const target = { workspace: "workspace", conversation: "main" }
    const body = {
      kind: "direct_reply" as const,
      text: mode === "unicode" ? "x".repeat(3999) + "😀 extra" : "x".repeat(5000),
      model: { model: "lane/current" },
    }
    try {
      const pending = titles.accept(target, "first", body)
      if (mode === "manual") {
        await generating.promise
        control.title = "My manual title"
        release.resolve()
      }
      if (mode === "shutdown") {
        await generating.promise
        const closing = titles.close()
        release.resolve()
        await closing
      }
      await pending
      expect(control.forks).toBe(mode === "none" ? 0 : 1)
      expect(control.removed).toBe(mode === "none" ? 0 : 1)
      expect(control.patches).toBe(["follow_current", "lane/title-model", "unicode"].includes(mode) ? 1 : 0)
      if (mode === "unicode") {
        expect(control.title).toBe("x".repeat(254) + "😀")
        expect(control.title.isWellFormed()).toBe(true)
      }
      const restarted = new ConversationTitles(fixture.client, () => "lane/other")
      await restarted.accept(target, "second", body)
      expect(control.forks).toBe(mode === "none" ? 0 : 1)
      await restarted.close()
    } finally {
      release.resolve()
      await titles.close()
      fixture.server.stop(true)
    }
  })
