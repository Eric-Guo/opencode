import { expect, test } from "bun:test"
import { Client } from "@cybros/agent"
import { RealtimeClient } from "@cybros/agent/realtime"
import { InferenceCommand } from "@opencode/protocol/nexus-command"
import { Schema } from "effect"
import { queuedInference } from "./fixture/inference"
import { eventually } from "./fixture/acp"
import { InferenceFollowers } from "../src/inference"

const decodeCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ command: Schema.String, identifier: Schema.String })),
)
const create = { action: "inference.create", key: "client-key", model: "fixture/model", input: "hello" } as const

test("a followed request switches subscriptions, replays its cursor and finishes from HTTP after a lost wake", async () => {
  const events: {
    public_id: string
    sequence: number
    cursor: string
    type: string
    occurred_at: string
    resource: { type: string; public_id: string }
    payload: Record<string, string>
  }[] = []
  const subscriptions: string[] = []
  const envelopes: unknown[] = []
  const cursors: (string | null)[] = []
  const result = Promise.withResolvers<void>()
  let sockets = 0
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "actioncable-v1-json" } })) return
      const url = new URL(request.url)
      if (request.method === "POST") {
        expect(request.headers.get("idempotency-key")).toBe(create.key)
        envelopes.push(await request.json())
        return Response.json({ inference_request: queuedInference }, { status: envelopes.length === 1 ? 202 : 200 })
      }
      if (url.pathname.endsWith("/events")) {
        const after = url.searchParams.get("after")
        cursors.push(after)
        return Response.json({
          events: events.slice(Number(after ?? 0)),
          pagination: { watermark: events.length, next_after: null },
        })
      }
      await result.promise
      return Response.json({
        inference_request: { ...queuedInference, result: { status: "succeeded", output_text: "Final answer" } },
      })
    },
    websocket: {
      open(socket) {
        sockets++
        socket.send(JSON.stringify({ type: "welcome" }))
      },
      message(socket, message) {
        const cmd = decodeCommand(message.toString())
        if (cmd.command !== "subscribe") {
          socket.unsubscribe(cmd.identifier)
          return
        }
        socket.subscribe(cmd.identifier)
        socket.send(JSON.stringify({ type: "confirm_subscription", identifier: cmd.identifier }))
        subscriptions.push(cmd.identifier)
      },
    },
  })
  const options = { baseURL: server.url.origin, credential: "fixture" }
  const followers = new InferenceFollowers(new Client(options), () => new RealtimeClient(options))
  const list = () => followers.command("workspace", { action: "inference.list" })
  const waitForText = (text: string) =>
    eventually(async () => {
      const rows = await list()
      return Array.isArray(rows) && rows[0]?.text === text
    })
  const change = (action: "inference.subscribe" | "inference.unsubscribe") =>
    followers.command("workspace", { action, request: "one" })
  const publish = (type: string, payload: Record<string, string>, live = true) => {
    const sequence = events.length + 1
    const event = {
      type,
      payload,
      sequence,
      cursor: String(sequence),
      public_id: "event-" + sequence,
      occurred_at: queuedInference.created_at,
      resource: { type: "inference_request", public_id: "one" },
    }
    events.push(event)
    if (live)
      server.publish(subscriptions.at(-1)!, JSON.stringify({ identifier: subscriptions.at(-1), message: { event } }))
  }
  try {
    const command = Schema.decodeUnknownSync(InferenceCommand)({
      ...create,
      configuration: { temperature: 0 },
      fallback_models: [],
      upload_public_ids: ["up", "up"],
      reasoning_enabled: false,
      reasoning_effort: "low",
      billing_subject: "test",
      model_selection: { source: "explicit", model: create.model, constraint: "route", alternatives: [] },
    })
    expect(() => Schema.decodeUnknownSync(InferenceCommand)({ ...create, key: undefined })).toThrow()
    const first = await Promise.all([followers.command("workspace", command), followers.command("workspace", command)])
    expect(first[0]).toEqual(first[1])
    expect(envelopes).toHaveLength(2)
    expect(envelopes[0]).toEqual({
      inference_request: {
        workload: "text_generation",
        model: { model: create.model, reasoning_enabled: false, reasoning_effort: "low" },
        input: "hello",
        configuration: { temperature: 0 },
        fallback_models: [],
        upload_public_ids: ["up", "up"],
        billing_subject: "test",
        model_selection: { source: "explicit", model: create.model, constraint: "route", alternatives: [] },
      },
    })
    expect(await followers.command("other-workspace", { action: "inference.list" })).toEqual([])
    await expect(
      followers.command("other-workspace", { action: "inference.subscribe", request: "one" }),
    ).rejects.toThrow("not following")
    await eventually(async () => subscriptions.length === 1)
    publish("run_status", { status: "running" })
    publish("text_delta", { text: "discarded" })
    await waitForText("discarded")
    expect(await list()).toMatchObject([{ text: "discarded", sequence: 2, status: "running" }])
    expect(await change("inference.unsubscribe")).toMatchObject({ changed: true, inference_request: { live: false } })
    expect(await change("inference.unsubscribe")).toMatchObject({ changed: false })
    await eventually(async () => subscriptions.length === 2)
    expect(JSON.parse(subscriptions[1]).items).toBe("lifecycle")
    publish("rollback", {}, false)
    publish("text_delta", { text: "replacement" }, false)
    expect(await change("inference.subscribe")).toMatchObject({ changed: true })
    await waitForText("replacement")
    expect(await list()).toMatchObject([{ text: "replacement", sequence: 4, live: true }])
    await eventually(async () => subscriptions.length === 3)
    for (const identifier of [subscriptions[0], subscriptions[2]]) {
      const identity = JSON.parse(identifier)
      expect(identity).toMatchObject({ workspace_id: "workspace", inference_request_id: "one" })
      expect(identity.items).toBeUndefined()
    }
    expect(cursors).toContain("2")
    expect(sockets).toBe(1)
    result.resolve()
    await waitForText("Final answer")
    expect(await list()).toMatchObject([{ complete: true, text: "Final answer", status: "succeeded" }])
  } finally {
    result.resolve()
    await followers.close()
  }
})

test("a create accepted across a disconnect returns the locator without starting a follower on the old credentials", async () => {
  const posted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const reads: string[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") reads.push(request.url)
      posted.resolve()
      await release.promise
      return Response.json({ inference_request: queuedInference }, { status: 202 })
    },
  })
  const client = new Client({ baseURL: server.url.origin, credential: "fixture" })
  const old = new InferenceFollowers(client)
  const creating = old.command("workspace", create)
  await posted.promise
  const closing = old.close()
  release.resolve()
  expect(await creating).toMatchObject({ public_id: "one" })
  await closing
  const replacement = new InferenceFollowers(client)
  expect(await replacement.command("workspace", { action: "inference.list" })).toEqual([])
  expect(reads).toBeEmpty()
  await replacement.close()
})

test.each(["result", "retention gap"])("the HTTP result wins after a %s on the event feed", async (scenario) => {
  const polling = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let reads = 0
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "POST") return Response.json({ inference_request: queuedInference }, { status: 202 })
      if (new URL(request.url).pathname.endsWith("/events")) {
        await polling.promise
        const events =
          scenario === "retention gap"
            ? []
            : [
                {
                  public_id: "terminal",
                  sequence: 1,
                  cursor: "cursor",
                  type: "result",
                  occurred_at: queuedInference.created_at,
                  resource: { type: "inference_request", public_id: "one" },
                  payload: { output_text: "event preview" },
                },
              ]
        return Response.json({ events, pagination: { watermark: 1, next_after: null } })
      }
      if (++reads === 1) {
        polling.resolve()
        await release.promise
      }
      return Response.json({
        inference_request: {
          ...queuedInference,
          result: { status: "failed", error: { code: "provider_unavailable" } },
        },
      })
    },
  })
  const followers = new InferenceFollowers(new Client({ baseURL: server.url.origin, credential: "fixture" }))
  const list = () => followers.command("workspace", { action: "inference.list" })
  try {
    await followers.command("workspace", create)
    if (scenario === "retention gap") {
      await eventually(async () => {
        const rows = await list()
        return Array.isArray(rows) && !!rows[0]?.issue
      })
      release.resolve()
    }
    await eventually(async () => {
      const rows = await list()
      return Array.isArray(rows) && rows[0]?.complete
    })
    expect(await list()).toMatchObject([
      {
        status: "failed",
        text: "",
        complete: true,
        sequence: scenario === "result" ? 1 : 0,
        result: { error: { code: "provider_unavailable" } },
      },
    ])
  } finally {
    release.resolve()
    await followers.close()
  }
})
