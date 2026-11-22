import { expect, test } from "bun:test"
import { Client } from "@cybros/agent"
import { RealtimeClient } from "@cybros/agent/realtime"
import { Schema } from "effect"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { NexusApplication } from "../src/application"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"
import { workerRegistration } from "../src/worker-extension"
import { runDevelopment } from "../dev/terminal"
import { storeFixture } from "./fixture/store"
import { conversationFixture } from "./fixture/conversation"
import descriptor from "../dev/extension.json"

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))

test("the real development extension preserves SDK methods, live iterators, identity and lifecycle across its worker", async () => {
  await using directory = await tmpdir()
  const subscribed = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const subscribedAgain = Promise.withResolvers<void>()
  const shutdown = Promise.withResolvers<void>()
  const connections = { subscribed: 0, closed: 0 }
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      requests.push(request.method + " " + new URL(request.url).pathname)
      expect(request.headers.get("authorization")).toBe("Bearer fixture")
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "actioncable-v1-json" } })) return
      if (new URL(request.url).pathname.endsWith("/conversations/side"))
        return Response.json({
          conversation: conversationFixture({ public_id: "side", side: true, source_conversation_public_id: "main" }),
        })
      return Response.json({
        run: {
          public_id: "run",
          status: "running",
          turn: { status: "running", conversation_public_id: "conversation" },
        },
      })
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "welcome" }))
      },
      message(socket, message) {
        const command = Schema.decodeUnknownSync(Schema.Struct({ command: Schema.String, identifier: Schema.String }))(
          JSON.parse(message.toString()),
        )
        if (command.command !== "subscribe") return
        socket.send(JSON.stringify({ type: "confirm_subscription", identifier: command.identifier }))
        const identity = object(JSON.parse(command.identifier))
        expect(identity.workspace_id).toBe("workspace")
        expect(identity).toMatchObject({
          channel: "AgentAPI::V1::ConversationEventsChannel",
          conversation_id: "conversation",
        })
        if (identity.items !== "transcript") return
        socket.send(
          JSON.stringify({
            identifier: command.identifier,
            message: { event: { type: "text_delta", run_public_id: "other", text: "Foreign" } },
          }),
        )
        socket.send(
          JSON.stringify({
            identifier: command.identifier,
            message: { event: { type: "text_delta", run_public_id: "run", text: "Worker transcript" } },
          }),
        )
        subscribed.resolve()
        if (++connections.subscribed === 2) subscribedAgain.resolve()
      },
      close() {
        closed.resolve()
        if (++connections.closed === 2) shutdown.resolve()
      },
    },
  })
  const options = { baseURL: server.url.origin, credential: "fixture" }
  const application = new NexusApplication(
    new Client(options),
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => new RealtimeClient(options),
  )
  const manager = new ExtensionManager(
    new Configuration(join(directory.path, "settings.json")),
    [
      {
        descriptor,
        register: workerRegistration(fileURLToPath(new URL("../dev/extension.ts", import.meta.url)), {
          startupMs: 10000,
          cancellationGraceMs: 500,
        }),
      },
    ],
    directory.path,
    new AbortController().signal,
    async () => {},
    () => application,
  )
  try {
    await manager.start()
    expect(manager.list()[0]).toMatchObject({ active: true, ready: true, diagnostics: [] })
    expect(await manager.command("dev", { action: "identity" })).toEqual(application.identity)
    const opened = object(await manager.command("dev", { action: "stream.open", run: "run" }))
    await subscribed.promise
    const frames: Schema.MutableJson[] = []
    const deadline = performance.now() + 5000
    while (performance.now() < deadline && !JSON.stringify(frames).includes("Worker transcript")) {
      const page = object(await manager.command("dev", { action: "stream.poll", stream: opened.stream }))
      frames.push(...Schema.decodeUnknownSync(Schema.Array(Schema.MutableJson))(page.events))
      if (!JSON.stringify(frames).includes("Worker transcript"))
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(JSON.stringify(frames)).toContain("Worker transcript")
    expect(JSON.stringify(frames)).not.toContain("Foreign")
    await manager.command("dev", { action: "stream.attach", run: "run" })
    const joined = object(await manager.command("dev", { action: "stream.open", run: "run" }))
    expect(joined.text).toBe("Worker transcript")
    await manager.command("dev", { action: "stream.close", stream: opened.stream })
    expect(await manager.command("dev", { action: "stream.followers" })).toMatchObject([{ run: "run", attached: true }])
    await manager.emit("host.ended", { workspace: "workspace", conversation: "conversation" })
    await closed.promise
    expect(await manager.command("dev", { action: "stream.followers" })).toEqual([])
    await runDevelopment(["attach", "run", "--host-type", "run"], {
      signal: new AbortController().signal,
      command: async (input) => Schema.decodeUnknownSync(Schema.MutableJson)(await manager.command("dev", input)),
      write() {},
      error() {},
    })
    await subscribedAgain.promise
    expect(await manager.command("dev", { action: "stream.followers" })).toEqual([
      { run: "run", conversation: "conversation", attached: true },
    ])
    expect(application.lifecycle.hostsSnapshot()).toEqual([])
    application.lifecycle.adopt("workspace", "side")
    expect(await manager.command("dev", { action: "followers" })).toMatchObject({ conversations: [] })
    expect(await manager.command("dev", { action: "followers", side: true })).toMatchObject({
      conversations: [{ public_id: "side", parent: "main" }],
      runs: [],
    })
    await manager.close()
    await shutdown.promise
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
  } finally {
    await manager.close()
    server.stop(true)
  }
}, 20000)

test("worker SDK failures preserve public error types and configured API values", async () => {
  await using directory = await tmpdir()
  const fixture = storeFixture(() => Response.json({ error: { code: "not_found" } }, { status: 404 }))
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  const manager = new ExtensionManager(
    new Configuration(join(directory.path, "configuration.json")),
    [
      {
        descriptor: {
          id: "worker.sdk",
          name: "SDK fixture",
          description: "Exercise the public SDK API in a worker.",
          default_enabled: true,
          configuration_version: 1,
          configuration_schema: {
            type: "object",
            properties: { marker: { type: "string" } },
            additionalProperties: false,
          },
          defaults: { marker: "configured" },
        },
        register: workerRegistration(fileURLToPath(new URL("./fixture/worker-sdk.ts", import.meta.url)), {
          startupMs: 10000,
          cancellationGraceMs: 500,
        }),
      },
    ],
    directory.path,
    new AbortController().signal,
    async () => {},
    () => application,
  )
  try {
    await manager.start()
    expect(await manager.command("sdk.inspect", {})).toEqual({
      missing: true,
      configuration: "configured",
      aborted: false,
    })
  } finally {
    await manager.close()
    fixture.server.stop(true)
  }
}, 15000)
