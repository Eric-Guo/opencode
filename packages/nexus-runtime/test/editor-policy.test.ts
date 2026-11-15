import { expect, test } from "bun:test"
import { editorFixture } from "./fixture/editor"
import { conversationFixture } from "./fixture/conversation"

test.each(["session/load", "session/resume"] as const)(
  "ACP %s accepts a foreign agent without local mode or editor attachments",
  async (method) => {
    const calls: string[] = []
    await using fixture = await editorFixture(
      (request) => {
        if (new URL(request.url).pathname.endsWith("/models"))
          expect(new URL(request.url).searchParams.get("workload")).toBe("text_generation")
        if (new URL(request.url).pathname.endsWith("/conversations/conversation"))
          return Response.json({
            conversation: conversationFixture({
              answering_user_public_id: "peer",
              default_runner: { executor_public_id: "remote", presence: "connected" },
            }),
          })
      },
      {
        modePolicy: async () => {
          throw new Error("Foreign policy must not use this Agent’s credential")
        },
        setCodeMode: async () => {
          calls.push("code")
        },
        setEnvironment: async () => {
          calls.push("environment")
        },
        attachMcp: async () => {
          calls.push("mcp")
          return { tools: [], issues: [] }
        },
      },
    )
    const loaded = await fixture.attach(method)
    expect(loaded.configOptions?.map((option) => option.id)).toEqual(["mode", "model"])
    await expect(
      fixture.peer.agent.request("session/set_config_option", {
        sessionId: "conversation",
        configId: "code_mode",
        value: "on",
      }),
    ).rejects.toMatchObject({ code: -32602 })
    expect(calls).toEqual([])
  },
)

test("ACP omits Code Mode when its extension is unavailable and preserves local editor attachment", async () => {
  const calls: string[] = []
  await using fixture = await editorFixture(
    (request) => {
      if (new URL(request.url).pathname.endsWith("/models"))
        expect(new URL(request.url).searchParams.get("workload")).toBe("text_generation")
      if (new URL(request.url).pathname.endsWith("/conversations/conversation"))
        return Response.json({
          conversation: conversationFixture({
            default_runner: { executor_public_id: "runner", presence: "connected" },
          }),
        })
    },
    {
      modePolicy: async () => ({ available: true, code_mode_available: false, code_mode: true }),
      setCodeMode: async () => {
        calls.push("code")
      },
      setEnvironment: async (_, binding) => {
        calls.push(binding ? "attached" : "detached")
      },
    },
  )
  const loaded = await fixture.attach("session/resume")
  expect(loaded.configOptions?.map((option) => option.id)).toEqual(["mode", "model"])
  expect(calls).toEqual(["attached"])
})

test("ACP submits foreign-agent input through addressed admission", async () => {
  const inputs: unknown[] = []
  await using fixture = await editorFixture(
    (request) => {
      if (new URL(request.url).pathname.endsWith("/conversations/conversation"))
        return Response.json({ conversation: conversationFixture({ answering_user_public_id: "peer" }) })
    },
    {
      async submit(input) {
        inputs.push(input)
        throw new Error("Admission fixture stopped before acceptance")
      },
    },
  )
  await fixture.attach("session/resume")
  await expect(fixture.prompt("Inspect this project")).rejects.toMatchObject({ code: -32603 })
  expect(inputs).toEqual([
    {
      conversation: "conversation",
      key: expect.any(String),
      text: "Inspect this project",
      model: undefined,
      approval: "ask",
      addressed: true,
      answering_user_public_id: "peer",
    },
  ])
})
