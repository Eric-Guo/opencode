import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import path from "path"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const originalHttpApi = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI
type SyncTrace = { type: string; directory?: string }

function app() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = false
  return Server.Default().app
}

function route(pathname: string, directory: string, query?: Record<string, string>) {
  const url = new URL(pathname, "http://localhost")
  url.searchParams.set("directory", directory)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return url
}

async function fetchJson<T>(
  pathname: string,
  directory: string,
  init?: RequestInit,
  query?: Record<string, string>,
) {
  const response = await app().fetch(new Request(route(pathname, directory, query), init))
  if (response.status !== 200) throw new Error(await response.text())
  return (await response.json()) as T
}

function pathFor(pathname: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), pathname)
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = originalHttpApi
  await Instance.disposeAll()
  await resetDatabase()
})

describe("Hono session routes", () => {
  test("use request directory for non-session routes and saved session directory for session routes", async () => {
    await using sessionDir = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false },
      init: (dir) => Bun.write(path.join(dir, "marker.txt"), "session-directory"),
    })
    await using requestDir = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false },
      init: (dir) => Bun.write(path.join(dir, "marker.txt"), "request-directory"),
    })

    const json = { "content-type": "application/json" }
    const trace: SyncTrace[] = []
    const onEvent = (event: GlobalEvent) => {
      if (event.payload.type !== "sync") return
      if (!["session.created.1", "message.updated.1", "message.part.updated.1"].includes(event.payload.syncEvent.type)) return
      trace.push({ type: event.payload.syncEvent.type, directory: event.directory })
    }
    GlobalBus.on("event", onEvent)

    const session = await fetchJson<{ id: string }>("/session", sessionDir.path, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "session-dir" }),
    })

    const currentPath = await fetchJson<{ directory: string }>("/path", requestDir.path)
    expect(currentPath.directory).toBe(requestDir.path)

    const marker = await fetchJson<{ type: string; content: string }>(
      "/file/content",
      requestDir.path,
      undefined,
      {
        path: "marker.txt",
      },
    )
    expect(marker).toMatchObject({ type: "text", content: "request-directory" })

    await fetchJson<unknown>(pathFor("/session/:sessionID", { sessionID: session.id }), requestDir.path)

    await fetchJson<unknown>(
      pathFor("/session/:sessionID/fork", { sessionID: session.id }),
      requestDir.path,
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({}),
      },
    )

    await fetchJson<{ info: { path: { cwd: string; root: string } }; parts: unknown[] }>(
      pathFor("/session/:sessionID/shell", { sessionID: session.id }),
      requestDir.path,
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          command: "pwd",
        }),
      },
    )
    GlobalBus.off("event", onEvent)

    expect(trace).toContainEqual({ type: "session.created.1", directory: sessionDir.path })
    expect(trace.filter((event) => event.type === "session.created.1")).toEqual([
      { type: "session.created.1", directory: sessionDir.path },
      { type: "session.created.1", directory: sessionDir.path },
    ])
    expect(trace.filter((event) => event.type === "message.updated.1").map((event) => event.directory)).toEqual(
      expect.arrayContaining([sessionDir.path]),
    )
    expect(trace.filter((event) => event.type === "message.updated.1").every((event) => event.directory === sessionDir.path))
      .toBe(true)
  })
})
