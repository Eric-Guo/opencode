import http from "node:http"
import https from "node:https"
import { connect } from "node:net"
import { NodeWS } from "@effect/platform-node/NodeSocket"
import type { Socket } from "node:net"
import { isString } from "effect/Predicate"

/** Local origins and real forwarding/CONNECT proxies. The PEMs are public test-only credentials. */
export async function proxyFixture(tls: { key: string; cert: string }) {
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const target = http.createServer((request, response) => response.end(request.url))
  const secure = https.createServer(tls, (request, response) => response.end(request.url))
  const plainSockets = new NodeWS.WebSocketServer({ server: target })
  const secureSockets = new NodeWS.WebSocketServer({ server: secure })
  plainSockets.on("connection", (socket) => socket.close())
  secureSockets.on("connection", (socket) => socket.close())

  const forward: http.RequestListener = (request, response) => {
    requests.push(request.url ?? "")
    const url = new URL(request.url ?? "")

    const outgoing = http.request(
      { hostname: "127.0.0.1", port: port(target), path: url.pathname, method: request.method, agent: false },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers)
        incoming.pipe(response)
      },
    )

    outgoing.on("error", () => response.writeHead(502).end())
    request.pipe(outgoing)
  }

  const proxy = http.createServer(forward)

  const proxyTls = https.createServer(tls, forward)

  ;[proxy, proxyTls].forEach((server) =>
    server.on("connect", (request, socket, head) => {
      requests.push(`CONNECT ${request.url}`)

      const upstream = connect(Number(request.url?.split(":").at(-1)), "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })

      sockets.add(upstream)
      upstream.on("close", () => sockets.delete(upstream))
      upstream.on("error", () => socket.destroy())
      socket.on("error", () => upstream.destroy())
    }),
  )
  // Node's ws:// HTTP proxy path sends an absolute-form Upgrade request.
  ;[proxy, proxyTls].forEach((server) =>
    server.on("upgrade", (request, socket, head) => {
      requests.push(`UPGRADE ${request.url}`)
      const url = new URL(request.url ?? "")

      const upstream = connect(port(target), "127.0.0.1", () => {
        upstream.write(
          `GET ${url.pathname} HTTP/1.1\r\n${Object.entries(request.headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\r\n")}\r\n\r\n`,
        )
        upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })

      sockets.add(upstream)
      upstream.on("close", () => sockets.delete(upstream))
      upstream.on("error", () => socket.destroy())
      socket.on("error", () => upstream.destroy())
    }),
  )
  const servers = [target, secure, proxy, proxyTls]
  servers.forEach((server) =>
    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    }),
  )
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))))

  return {
    requests,
    httpProxy: `http://127.0.0.1:${port(proxy)}`,
    httpsProxy: `https://localhost:${port(proxyTls)}`,
    httpTarget: `http://target.test:${port(target)}`,
    httpsTarget: `https://target.test:${port(secure)}`,
    local: `http://127.0.0.1:${port(target)}`,
    async stopHttpProxy() {
      sockets.forEach((socket) => socket.destroy())
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    },
    async close() {
      sockets.forEach((socket) => socket.destroy())
      plainSockets.close()
      secureSockets.close()
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    },
  }
}

function port(server: http.Server | https.Server) {
  const address = server.address()

  if (!address || isString(address)) throw new Error("Expected TCP listener")

  return address.port
}
