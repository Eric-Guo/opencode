import { client, type AnyMessage, type SessionNotification } from "@agentclientprotocol/sdk"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editor, type EditorOptions } from "../../src/editor"
import { conversationFixture } from "./conversation"

export async function editorFixture(
  route: (request: Request) => Response | undefined | Promise<Response | undefined>,
  options: EditorOptions = {},
  configuration = client(),
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nexus-editor-")))
  const updates: SessionNotification[] = []
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(request.method + " " + new URL(request.url).pathname)
      const response = await route(request)

      if (response) return response

      const path = new URL(request.url).pathname

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
      if (path.endsWith("/models")) return Response.json({ models: [] })
      if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
      if (path.endsWith("/history"))
        return Response.json({
          conversation: { public_id: "conversation", title: null },
          turns: [],
          pagination: { has_older: false, has_newer: false },
          truncated: false,
        })
      if (path.endsWith("/events")) return Response.json({ events: [], pagination: { next_after: null, watermark: 0 } })
      if (path.endsWith("/transcript"))
        return Response.json({ rounds: [], pagination: { has_older: false, next_before: null } })

      return Response.json({ error: { code: "not_found" } }, { status: 404 })
    },
  })
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
      identity: { agent: "main", runner: "runner", workspace: "workspace", name: "Fixture", workspaceName: "Fixture" },
    },
    "human",
    options,
  )
  const peer = configuration
    .onNotification("session/update", ({ params }) => {
      updates.push(params)
    })
    .connect({ readable: outbound.readable, writable: inbound.writable })

  await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} })

  return {
    peer,
    directory,
    updates,
    requests,
    async attach(method: "session/load" | "session/resume" = "session/load") {
      return peer.agent.request(method, { sessionId: "conversation", cwd: directory, mcpServers: [] })
    },
    async prompt(text: string) {
      return peer.agent.request("session/prompt", { sessionId: "conversation", prompt: [{ type: "text", text }] })
    },
    async [Symbol.asyncDispose]() {
      peer.close()
      await inbound.writable.close()
      await work
      server.stop(true)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
