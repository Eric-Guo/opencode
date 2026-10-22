import assert from "node:assert/strict"
import http from "node:http"
import https from "node:https"
import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { HttpClient, FetchHttpClient } from "effect/http"
import { Socket } from "effect/socket"
import { WebSocketConstructor } from "../../../core/src/effect/websocket-constructor"
import { configureNodeProxyFromEnv, getProxyEnvironment } from "../../src/main/proxy"
import { proxyFixture } from "./proxy"

const fixture = await proxyFixture({
  key: await readFile(process.argv[2]!, "utf8"),
  cert: await readFile(process.argv[3]!, "utf8"),
})

try {
  for (const proxy of [fixture.httpProxy, fixture.httpsProxy]) {
    const environment = getProxyEnvironment({ mode: "manual", url: proxy, bypass: "" }, {})
    assert.equal(WebSocketConstructor.proxy("wss://[::1]:4096/socket", environment), undefined)
    Object.assign(process.env, environment)
    const restore = configureNodeProxyFromEnv(environment)

    try {
      for (const origin of [fixture.httpTarget, fixture.httpsTarget]) {
        assert.equal(await (await fetch(`${origin}/fetch`)).text(), "/fetch")
        assert.equal(
          await new Promise<string>((resolve, reject) => {
            const request = (origin.startsWith("https:") ? https : http).get(`${origin}/native`, (response) => {
              const chunks: Buffer[] = []
              response.on("data", (chunk: Buffer) => chunks.push(chunk))
              response.on("end", () => resolve(Buffer.concat(chunks).toString()))
            })

            request.on("error", reject)
          }),
          "/native",
        )
        // Model and tool requests use this same Effect FetchHttpClient transport.
        assert.equal(
          await Effect.runPromise(
            Effect.gen(function* () {
              const client = yield* HttpClient.HttpClient
              const response = yield* client.get(`${origin}/effect`)

              return yield* response.text
            }).pipe(Effect.provide(FetchHttpClient.layer)),
          ),
          "/effect",
        )
        const create = Effect.runSync(Socket.WebSocketConstructor.pipe(Effect.provide(WebSocketConstructor.layer)))
        await new Promise<void>((resolve, reject) => {
          const socket = create(origin.replace(/^http/, "ws") + "/socket")
          socket.addEventListener("open", () => resolve(), { once: true })
          socket.addEventListener("error", reject, { once: true })
        })
      }

      assert(fixture.requests.some((request) => request.startsWith("CONNECT target.test:")))
      const count = fixture.requests.length
      assert.equal(await (await fetch(fixture.local + "/local")).text(), "/local")
      assert.equal(fixture.requests.length, count)
    } finally {
      restore()
    }
  }

  await fixture.stopHttpProxy()

  const restoreFailed = configureNodeProxyFromEnv(
    getProxyEnvironment({ mode: "manual", url: fixture.httpProxy, bypass: "" }, {}),
  )

  try {
    await assert.rejects(fetch(fixture.httpTarget + "/unreachable"))
    assert.equal(await (await fetch(fixture.local + "/repair")).text(), "/repair")
  } finally {
    restoreFailed()
  }

  const count = fixture.requests.length
  const restore = configureNodeProxyFromEnv(getProxyEnvironment({ mode: "direct" }, { HTTP_PROXY: fixture.httpProxy }))

  try {
    assert.equal(await (await fetch(fixture.local + "/direct")).text(), "/direct")
    assert.equal(fixture.requests.length, count)
  } finally {
    restore()
  }

  console.info(
    "HTTP/HTTPS proxies: fetch, native HTTP, Effect model/tool transport, WebSockets, loopback and Direct passed",
  )
} finally {
  await fixture.close()
}
