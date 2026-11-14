import { expect, test } from "bun:test"
import { agent, client, type AnyMessage } from "@agentclientprotocol/sdk"
import { authenticateEditor, type EditorAuthentication } from "../src/editor-auth"
import type { Status } from "../src/runtime"

const ready: Status = {
  state: "ready",
  origin: "https://nexus.example",
  directory: "/project",
  model: "model",
  workspace: "workspace",
  identity: { agent: "main", runner: "runner", workspace: "workspace", name: "Main", workspaceName: "Workspace" },
}

test("ACP URL authentication observes the shared ceremony and completes the editor card", async () => {
  const opened = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<string>()
  const state = { signedIn: false, starts: 0 }
  const authentication: EditorAuthentication = {
    async status() {
      if (state.starts) await opened.promise
      return ready
    },
    async credential() {
      return state.signedIn ? "member-access" : null
    },
    async start() {
      state.starts++
      return { url: "https://nexus.example/sign-in", code: "ABC" }
    },
  }
  const inbound = new TransformStream<AnyMessage>()
  const outbound = new TransformStream<AnyMessage>()
  const connection = agent()
    .onRequest("authenticate", async (context) => {
      await authenticateEditor(
        authentication,
        context.client,
        { elicitation: { url: {} } },
        context.signal,
        context.requestId,
      )
      return {}
    })
    .connect({ readable: inbound.readable, writable: outbound.writable })
  const cards: string[] = []
  const peer = client()
    .onRequest("elicitation/create", ({ params }) => {
      expect(params).toMatchObject({ mode: "url", url: "https://nexus.example/sign-in" })
      if (params.mode === "url") cards.push(String(params.elicitationId))
      state.signedIn = true
      opened.resolve()
      return { action: "accept" }
    })
    .onNotification("elicitation/complete", ({ params }) => completed.resolve(params.elicitationId))
    .connect({ readable: outbound.readable, writable: inbound.writable })

  try {
    expect(await peer.agent.request("authenticate", { methodId: "nexus" })).toEqual({})
    expect(await completed.promise).toBe(cards[0])
    expect(state.starts).toBe(1)
    await peer.agent.request("authenticate", { methodId: "nexus" })
    expect(state.starts).toBe(1)
  } finally {
    peer.close()
    await inbound.writable.close()
    await connection.closed
  }
})

test("ACP authentication without URL elicitation returns the shared ceremony URL and code", async () => {
  const inbound = new TransformStream<AnyMessage>()
  const outbound = new TransformStream<AnyMessage>()
  const connection = agent()
    .onRequest("authenticate", async (context) => {
      await authenticateEditor(
        {
          async status() {
            return { ...ready, state: "pairing" }
          },
          async credential() {
            return null
          },
          async start() {
            return { url: "https://nexus.example/device?code=ABC", code: "ABC" }
          },
        },
        context.client,
        {},
        context.signal,
        context.requestId,
      )
      return {}
    })
    .connect({ readable: inbound.readable, writable: outbound.writable })
  const peer = client().connect({ readable: outbound.readable, writable: inbound.writable })

  try {
    await expect(peer.agent.request("authenticate", { methodId: "nexus" })).rejects.toMatchObject({
      code: -32000,
      data: { url: "https://nexus.example/device?code=ABC", code: "ABC" },
    })
  } finally {
    peer.close()
    await inbound.writable.close()
    await connection.closed
  }
})
