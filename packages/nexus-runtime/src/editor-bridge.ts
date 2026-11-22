import { RequestError, type AgentContext, type ClientCapabilities } from "@agentclientprotocol/sdk"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { Schema } from "effect"

export const EditorBinding = Schema.Struct({
  url: Schema.String.check(
    Schema.makeFilter(
      (value) => /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?=[:/?#]|$)/.test(value) && URL.canParse(value),
    ),
  ),
  token: Schema.NonEmptyString,
  session: Schema.NonEmptyString,
  client: Schema.optional(Schema.String),
  roots: Schema.NonEmptyArray(Schema.String),
  read: Schema.Boolean,
  write: Schema.Boolean,
})
export type EditorBinding = typeof EditorBinding.Type

const BridgeRequest = Schema.Struct({
  session: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  content: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})

export async function editorBridge() {
  const token = crypto.randomUUID()
  const sessions = new Map<string, { roots: string[]; client: AgentContext; capabilities: ClientCapabilities }>()
  const handle = async (request: Request): Promise<Response> => {
    if (request.method !== "POST" || request.headers.get("authorization") !== "Bearer " + token)
      return new Response("Unauthorized", { status: 401 })

    try {
      const input = Schema.decodeUnknownSync(BridgeRequest)(await request.json())
      const session = sessions.get(input.session)

      if (!session)
        return Response.json({ error: { code: "closed", message: "Editor session has closed" } }, { status: 410 })

      const path = resolve(session.roots[0], input.path)
      const canonical = await editorPath(path)

      if (
        !session.roots.some((root) => {
          const remainder = relative(root, canonical)

          return (
            remainder !== ".." &&
            !remainder.startsWith("../") &&
            !remainder.startsWith("..\\") &&
            !isAbsolute(remainder)
          )
        })
      )
        return Response.json(
          { error: { code: "editor_refused", message: "Path is outside the editor session roots" } },
          { status: 403 },
        )

      const action = new URL(request.url).pathname

      if (["/read", "/fs/read"].includes(action) && session.capabilities.fs?.readTextFile) {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)])
        const response = await editorRequest(
          session.client.request(
            "fs/read_text_file",
            { sessionId: input.session, path, line: input.line, limit: input.limit },
            { cancellationSignal: signal },
          ),
          signal,
        )

        if (!response.content && (input.line ?? 1) > 1)
          return Response.json(
            { error: { code: "beyond_eof", message: "Requested line is beyond the end of the editor buffer" } },
            { status: 422 },
          )

        return Response.json(response)
      }
      if (
        ["/write", "/fs/write"].includes(action) &&
        session.capabilities.fs?.writeTextFile &&
        input.content !== undefined
      ) {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55000)])

        await editorRequest(
          session.client.request(
            "fs/write_text_file",
            { sessionId: input.session, path, content: input.content },
            { cancellationSignal: signal },
          ),
          signal,
        )
        return Response.json({})
      }

      return Response.json(
        { error: { code: "editor_refused", message: "Unsupported editor filesystem operation" } },
        { status: 422 },
      )
    } catch (error) {
      const code =
        error instanceof RequestError
          ? error.code === -32002
            ? "not_found"
            : error.code === -32602
              ? "beyond_eof"
              : error.code === -32800
                ? "cancelled"
                : "editor_refused"
          : error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : "unavailable"

      return Response.json(
        { error: { code, message: error instanceof Error ? error.message : "Editor filesystem request failed" } },
        { status: code === "not_found" ? 404 : code === "timeout" ? 504 : code === "unavailable" ? 503 : 422 },
      )
    }
  }
  const server = createServer((request, response) => {
    const owner = new AbortController()
    const headers = new Headers()

    for (let index = 0; index < request.rawHeaders.length; index += 2)
      headers.append(request.rawHeaders[index], request.rawHeaders[index + 1])
    response.once("close", () => owner.abort())
    const incoming = {
      method: request.method,
      headers,
      signal: owner.signal,
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : {
            body: Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>,
            duplex: "half" as const,
          }),
    }

    void handle(new Request(new URL(request.url ?? "/", url).href, incoming))
      .then(async (result) => {
        if (response.destroyed) return

        response.writeHead(result.status, Object.fromEntries(result.headers))
        if (result.body) for await (const chunk of result.body) response.write(chunk)
        response.end()
      })
      .catch(() => {
        if (!response.destroyed) response.writeHead(500).end("Editor bridge request failed")
      })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()

  if (!address || typeof address === "string") throw new Error("Could not open the editor filesystem bridge")

  const url = "http://127.0.0.1:" + address.port

  return {
    attach(id: string, roots: string[], client: AgentContext, capabilities: ClientCapabilities) {
      sessions.set(id, { roots, client, capabilities })

      return {
        url,
        token,
        session: id,
        roots,
        read: capabilities.fs?.readTextFile === true,
        write: capabilities.fs?.writeTextFile === true,
      }
    },
    release(id: string) {
      sessions.delete(id)
    },
    close() {
      sessions.clear()
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()))

      server.closeAllConnections()
      return stopped
    },
  }
}

async function editorRequest<T>(request: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const abort = () => aborted.reject(signal.reason)

  signal.addEventListener("abort", abort, { once: true })
  try {
    return await Promise.race([request, aborted.promise])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

export function editorRoots(cwd: string, additional: readonly string[] = []) {
  const roots = [cwd, ...additional]
  if (!roots.every(isAbsolute))
    throw RequestError.invalidParams(undefined, "Editor workspace roots must be absolute paths.")
  if (Buffer.byteLength(JSON.stringify(roots)) > 4096)
    throw RequestError.invalidParams(undefined, "Editor workspace roots exceed 4096 bytes.")
  return roots
}

export async function localEditorRoots(paths: string[]) {
  const roots = await Promise.all(
    paths.map(async (path) => {
      const canonical = await realpath(path).catch(() => undefined)
      if (!canonical || !(await stat(canonical)).isDirectory())
        throw RequestError.invalidParams(undefined, path + " is not a directory")
      return canonical
    }),
  )
  return [...new Set(roots)]
}

// Unsaved editor buffers can live in directories that have not been created on disk yet.
async function editorPath(path: string): Promise<string> {
  return realpath(path).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" || dirname(path) === path) throw error

    return resolve(await editorPath(dirname(path)), basename(path))
  })
}
