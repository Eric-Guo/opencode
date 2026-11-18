import { expect, test } from "bun:test"
import { DeviceFlow, OAuthCredentials, type OAuthDocument } from "@cybros/agent"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { AgentRenewal } from "../src/renewal"
import { vault } from "../src/storage"

test("a rotated pair survives a publication failure and both planes verify a later refusal together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-renewal-"))
  const store = vault(join(dir, "agent.json"))
  let now = Date.now()
  const original: OAuthDocument = {
    version: 2,
    authentication_kind: "oauth",
    connection: "agent",
    rotation: 0,
    refresh_token: "refresh-0",
    access_token: "member-0",
    executor_access_token: "executor-0",
    expires_at: new Date(now + 86400_000).toISOString(),
  }
  const calls: string[] = []
  const sockets: (string | null)[] = []
  let refuse = false
  const refused = Promise.withResolvers<void>()
  let resources = 0
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "actioncable-v1-json" } })) {
        sockets.push(request.headers.get("authorization"))
        return
      }
      if (new URL(request.url).pathname === "/oauth/token") {
        const form = await request.formData()
        expect(form.get("refresh_token")).toBe("refresh-" + calls.length)
        calls.push(String(form.get("refresh_token")))
        if (refuse) return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({
          plane: "member",
          token_type: "Bearer",
          refresh_token: "refresh-" + calls.length,
          access_token: "member-" + calls.length,
          executor_access_token: "executor-" + calls.length,
          expires_in: 14 * 86400,
        })
      }
      if (request.headers.get("authorization")?.endsWith("-1")) {
        if (++resources === 2) refused.resolve()
        await refused.promise
        return new Response(null, { status: 401 })
      }
      return new Response(null, { status: refuse ? 401 : 204 })
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "welcome" }))
      },
      message(socket, data) {
        const message = Schema.decodeUnknownSync(Schema.Struct({ command: Schema.String, identifier: Schema.String }))(
          JSON.parse(data.toString()),
        )
        if (message.command === "subscribe")
          socket.send(JSON.stringify({ type: "confirm_subscription", identifier: message.identifier }))
      },
    },
  })
  const stop = new AbortController()
  const waiting = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let durable = false
  try {
    await store.write(original)
    const credentials = new OAuthCredentials({
      authority: new DeviceFlow({ baseURL: server.url.origin }),
      document: original,
      clock: () => now,
      store: {
        ...store,
        write: async (document) => {
          if (!durable) throw Error("storage offline")
          await store.write(document)
        },
      },
    })
    const renewal = new AgentRenewal(credentials, {
      now: () => now,
      wait: async (ms) => {
        expect(ms).toBe(3600_000)
        if (durable) {
          stop.abort()
          return
        }
        waiting.resolve()
        await resume.promise
      },
    })
    const work = renewal.maintain(stop.signal)
    await waiting.promise
    expect(renewal.issue).toContain("storage publication failed")
    expect(await credentials.memberCredential()).toBe("member-1")
    expect(await store.read()).toMatchObject({ rotation: 0 })
    durable = true
    resume.resolve()
    await work
    expect(await store.read()).toMatchObject({ rotation: 1 })
    expect(calls).toEqual(["refresh-0"])
    const read = async (plane: "member" | "executor") => {
      const options = renewal.options(server.url.origin, plane)
      return options.fetch(server.url, { headers: { authorization: "Bearer " + (await options.credentialProvider()) } })
    }
    const socket = renewal.socket(renewal.options(server.url.origin, "executor"))
    try {
      const first = await socket.executorInbox()
      expect((await Promise.all([read("member"), read("executor")])).map((response) => response.status)).toEqual([
        204, 204,
      ])
      expect((await first[Symbol.asyncIterator]().next()).done).toBe(true)
      const second = await socket.executorInbox()
      expect(sockets).toEqual(["Bearer executor-1", "Bearer executor-2"])
      second.close()
    } finally {
      await socket.close()
    }
    expect(calls).toEqual(["refresh-0", "refresh-1"])
    refuse = true
    expect((await read("executor")).status).toBe(401)
    expect(calls).toHaveLength(2)
    now += 5 * 60_000
    expect((await read("executor")).status).toBe(401)
    expect(renewal.lost.signal.aborted).toBe(true)
    expect(calls).toEqual(["refresh-0", "refresh-1", "refresh-2"])
  } finally {
    resume.resolve()
    stop.abort()
    await rm(dir, { recursive: true, force: true })
  }
})
