import { expect, test } from "bun:test"
import { Schema } from "effect"
import { join } from "node:path"
import { symlink } from "node:fs/promises"
import { scheduler } from "node:timers/promises"
import type { JsonObject } from "@cybros/agent"
import type { EditorBinding } from "../src/editor-bridge"
import { RunnerAdmission, runClaim } from "../src/runner"
import { RunnerInbox } from "../src/runner-inbox"
import { ClaimInterrupted } from "../src/claim-control"
import { executorFixture } from "./fixture/executor"

test.each([
  ["timeout", 504, { error: { code: "timeout", message: "timed out" } }],
  ["plain server error", 503, "offline"],
  ["authentication", 401, "Unauthorized"],
  ["malformed refusal", 422, {}],
  ["malformed JSON", 200, "not JSON"],
  ["malformed read", 200, { content: 42 }],
  ["non-object read", 200, null],
])("editor %s retires the binding and reads disk with one notice", async (_name, status, body) => {
  await using fixture = await filesystemFixture()
  fixture.control.reply = () =>
    typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status })

  const first = await fixture.call("read", { path: "file" })

  expect(first.outcome).toBe("completed")
  expect(first.content).toContain("zed did not answer")
  expect(String(first.content).split("read from disk")).toHaveLength(2)
  expect(first.content).toEndWith("\n\ndisk")
  expect(fixture.dropped).toHaveLength(1)
  expect(await fixture.call("read", { path: "file" })).toMatchObject({ outcome: "completed", content: "disk" })
  expect(fixture.requests).toHaveLength(1)
})

test("failed disk fallback preserves the editor notice and a replacement binding", async () => {
  await using fixture = await filesystemFixture()
  fixture.control.reply = () => {
    fixture.control.binding = { ...fixture.binding, token: "replacement" }
    return Response.json({ error: { code: "unavailable", message: "offline" } }, { status: 503 })
  }

  const result = await fixture.call("read", { path: "missing" })

  expect(result).toMatchObject({ outcome: "completed", is_error: true })
  expect(result.content).toStartWith("[zed did not answer the read (offline); read from disk.]\n\n")
  expect(result.content).toContain("missing")
  expect(fixture.control.binding?.token).toBe("replacement")
  expect(fixture.dropped).toEqual([fixture.binding])
})

test.each(["write", "edit-read", "edit-write"])(
  "malformed editor acknowledgements during %s never report success or mutate disk",
  async (stage) => {
    await using fixture = await filesystemFixture()
    fixture.control.reply = (request) =>
      stage === "edit-write" && new URL(request.url).pathname === "/fs/read"
        ? Response.json({ content: "unsaved" })
        : Response.json(null)

    const result = await fixture.call(
      stage === "write" ? "write" : "edit",
      stage === "write"
        ? { path: "file", content: "new" }
        : { path: "file", edits: [{ oldText: "unsaved", newText: "new" }] },
    )

    expect(result).toMatchObject({ outcome: "completed", is_error: true })
    expect(result.content).toContain("zed did not confirm")
    expect(fixture.dropped).toHaveLength(1)
    expect(await Bun.file(join(fixture.directory, "file")).text()).toBe("disk")
    expect(fixture.requests).toHaveLength(stage === "edit-write" ? 2 : 1)
  },
)

test("editor not-found falls back per call, but a refused edit write cannot replay on disk", async () => {
  await using fixture = await filesystemFixture()
  fixture.control.reply = () => Response.json({ error: { code: "not_found", message: "no buffer" } }, { status: 404 })

  expect(await fixture.call("read", { path: "file" })).toMatchObject({ outcome: "completed", content: "disk" })
  expect(await fixture.call("write", { path: "created", content: "new" })).toMatchObject({ outcome: "completed" })
  expect(await Bun.file(join(fixture.directory, "created")).text()).toBe("new")
  expect(await fixture.call("edit", { path: "file", edits: [{ oldText: "disk", newText: "changed" }] })).toMatchObject({
    outcome: "completed",
  })
  fixture.control.reply = (request) =>
    new URL(request.url).pathname === "/fs/read"
      ? Response.json({ content: "unsaved" })
      : Response.json({ error: { code: "not_found", message: "buffer closed" } }, { status: 404 })

  expect(await fixture.call("edit", { path: "file", edits: [{ oldText: "unsaved", newText: "new" }] })).toMatchObject({
    outcome: "completed",
    is_error: true,
  })
  expect(await Bun.file(join(fixture.directory, "file")).text()).toBe("changed")
  expect(fixture.dropped).toHaveLength(0)
})

test("editor reads page unsaved buffers and normalize both beyond-EOF shapes", async () => {
  await using fixture = await filesystemFixture()
  fixture.control.reply = async (request) => {
    const input = Schema.decodeUnknownSync(Schema.Struct({ line: Schema.Int, limit: Schema.Int }))(await request.json())

    expect(input).toEqual({ line: 3, limit: 3 })
    return Response.json({ content: "three\nfour\nfive" })
  }

  expect(await fixture.call("read", { path: "file", offset: 3, limit: 2 })).toMatchObject({
    content: "three\nfour\n\n[Showing lines 3-4; more lines remain. Use offset=5 to continue.]",
  })
  fixture.control.reply = () => Response.json({ content: "x".repeat(60 * 1024) })
  expect(await fixture.call("read", { path: "file's draft", offset: 7, limit: 1 })).toMatchObject({
    content:
      "[Line 7 is 61440 bytes, exceeds 50 KiB limit. Use bash: sed -n '7p' < 'file'\\''s draft' | head -c 51200]",
    structured_content: { truncation: { first_line_exceeds_limit: true, max_bytes: 51200 } },
  })
  for (const body of [{ content: "" }, { error: { code: "beyond_eof", message: "no line" } }]) {
    fixture.control.reply = () => Response.json(body, { status: "error" in body ? 422 : 200 })
    expect(await fixture.call("read", { path: "file", offset: 5 })).toMatchObject({
      outcome: "completed",
      is_error: true,
      content: expect.stringContaining("Offset 5 is beyond end of file"),
    })
  }
  expect(fixture.dropped).toHaveLength(0)
})

test("explicit editor refusals name the client and retain the binding", async () => {
  await using fixture = await filesystemFixture()
  fixture.control.reply = () =>
    Response.json({ error: { code: "editor_refused", message: "outside editor roots" } }, { status: 403 })

  expect(await fixture.call("read", { path: "file" })).toMatchObject({
    outcome: "completed",
    is_error: true,
    content: "zed: outside editor roots",
  })
  expect(fixture.dropped).toHaveLength(0)
})

test.each(["read", "write", "edit"])("editor cancellation interrupts %s without disk effects", async (tool) => {
  await using fixture = await filesystemFixture()
  fixture.control.reply = () =>
    Response.json({ error: { code: "cancelled", message: "cancelled request" } }, { status: 422 })

  expect(
    await fixture.call(
      tool,
      tool === "write"
        ? { path: "file", content: "new" }
        : tool === "edit"
          ? { path: "file", edits: [{ oldText: "unsaved", newText: "new" }] }
          : { path: "file" },
    ),
  ).toMatchObject({ outcome: "failed", content: expect.stringContaining("zed cancelled") })
  expect(fixture.dropped).toHaveLength(0)
  expect(await Bun.file(join(fixture.directory, "file")).text()).toBe("disk")
})

test("an aborted execution retains its reason when the editor cancels", async () => {
  await using fixture = await filesystemFixture()
  const owner = new AbortController()
  const reason = new ClaimInterrupted("original interruption")
  fixture.control.reply = () => {
    owner.abort(reason)
    return Response.json({ error: { code: "cancelled", message: "editor cancelled" } }, { status: 422 })
  }

  await expect(
    runClaim(fixture.client, fixture.row("read", { path: "file" }), fixture.directory, owner.signal),
  ).rejects.toBe(reason)
})

test("canceling a queued editor task releases its handler while another task holds the file", async () => {
  await using fixture = await filesystemFixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()

  fixture.control.reply = async (request) => {
    const input = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }))(await request.json())
    if (input.content !== "first") return Response.json({})

    entered.resolve()
    await release.promise
    return Response.json({})
  }

  const first = fixture.call("write", { path: "file", content: "first" })

  await entered.promise

  const second = fixture.row("write", { path: "file", content: "canceled" })

  try {
    await fixture.runner.sweep()
    await runClaim(
      fixture.client,
      { ...second, tool_input: { path: "other", content: "independent" } },
      fixture.directory,
      new AbortController().signal,
    )
    fixture.runner.notify({ event: { type: "work_canceled", run_public_id: "run", task_key: second.task_key } })

    const deadline = Date.now() + 3000
    while (fixture.runner.snapshot().in_flight !== 1) {
      if (Date.now() >= deadline) throw new Error("Canceled editor handler did not release while the file was held.")
      await scheduler.yield()
    }

    expect(fixture.results.get(JSON.stringify(["run", second.task_key]))).toMatchObject({ outcome: "failed" })
    expect(fixture.requests).toEqual(["/fs/write", "/fs/write"])
    expect(await Bun.file(join(fixture.directory, "file")).text()).toBe("disk")
  } finally {
    release.resolve()
    await first
  }
})

test.each(["file", "missing/child/file"])(
  "editor edits serialize symlink aliases of %s and preserve request paths",
  async (path) => {
    await using fixture = await filesystemFixture()
    await symlink(fixture.directory, join(fixture.directory, "alias"), "junction")

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const paths: string[] = []
    const buffer = { content: "alpha beta" }

    fixture.control.reply = async (request) => {
      const input = Schema.decodeUnknownSync(
        Schema.Struct({ path: Schema.String, content: Schema.optional(Schema.String) }),
      )(await request.json())

      paths.push(input.path)
      if (input.content !== undefined) {
        buffer.content = input.content
        return Response.json({})
      }

      const content = buffer.content
      if (paths.length === 1) {
        entered.resolve()
        await release.promise
      }

      return Response.json({ content })
    }

    const call = (tool: string, input: JsonObject) =>
      runClaim(fixture.client, fixture.row(tool, input), fixture.directory, new AbortController().signal)
    const first = call("edit", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] })

    await entered.promise

    const second = call("edit", { path: "alias/" + path, edits: [{ oldText: "beta", newText: "BETA" }] })

    try {
      // Complete independent filesystem work while the first editor read is held.
      await call("write", { path: "other", content: "independent" })
    } finally {
      release.resolve()
      await Promise.all([first, second])
    }

    expect(buffer.content).toBe("ALPHA BETA")
    expect(paths.filter((value) => value.endsWith(path))).toEqual([
      join(fixture.directory, path),
      join(fixture.directory, path),
      join(fixture.directory, "alias", path),
      join(fixture.directory, "alias", path),
    ])
    expect(await Bun.file(join(fixture.directory, "file")).text()).toBe("disk")
    expect(fixture.dropped).toHaveLength(0)
  },
)

async function filesystemFixture() {
  const fixture = await executorFixture()
  const binding: EditorBinding = {
    url: fixture.server.url.origin,
    token: "editor-token",
    session: "editor",
    client: "zed",
    roots: [fixture.directory],
    read: true,
    write: true,
  }
  const control: { binding?: EditorBinding; reply(request: Request): Response | Promise<Response> } = {
    binding,
    reply: () => Response.json({ content: "unsaved" }),
  }
  const requests: string[] = []
  const dropped: EditorBinding[] = []
  fixture.control.route = async (request) => {
    const path = new URL(request.url).pathname
    if (!path.startsWith("/fs/")) return

    expect(request.headers.get("authorization")).toBe("Bearer " + control.binding?.token)
    requests.push(path)
    return control.reply(request)
  }
  const runner = new RunnerInbox({
    executor: fixture.client,
    id: "executor",
    root: fixture.directory,
    journal: fixture.journal,
    signal: new AbortController().signal,
    extensions: () => [],
    admission: new RunnerAdmission(),
    startupLimit: 8,
    wake() {},
    ports: {
      read: () => control.binding,
      drop(_workspace, _anchor, expected) {
        dropped.push(expected)
        if (control.binding === expected) control.binding = undefined
      },
    },
  })
  const row = (tool: string, input: JsonObject) =>
    fixture.add("run", crypto.randomUUID(), tool, {
      tool_input: input,
      executor_context: {
        "opencode.environment": { root: fixture.directory, anchor: "anchor" },
        "opencode.editor": { ...binding, roots: [...binding.roots] },
      },
    })

  await Bun.write(join(fixture.directory, "file"), "disk")
  return {
    ...fixture,
    binding,
    control,
    requests,
    dropped,
    runner,
    row,
    async call(tool: string, input: JsonObject) {
      const task = row(tool, input)
      await runner.sweep()
      await runner.drain()
      const result = fixture.results.get(JSON.stringify(["run", task.task_key]))
      expect(result).toBeDefined()
      return result!
    },
    async [Symbol.asyncDispose]() {
      await runner.close()
      await fixture.close()
    },
  }
}
