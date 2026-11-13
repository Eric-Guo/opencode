import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mutate } from "../src/mutation"
import { execute } from "../src/runner"
import { NexusRuntime } from "../src/runtime"

let fixture: string
let root: string
const signal = new AbortController().signal

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "nexus-runner-")))
  root = join(fixture, "project")
  await mkdir(root)
})

afterEach(() => rm(fixture, { recursive: true, force: true }))

test("file reads respect the directory binding", async () => {
  await writeFile(join(root, "readme.txt"), "Nexus fixture")
  await writeFile(join(fixture, "outside.txt"), "private")
  await symlink(join(fixture, "outside.txt"), join(root, "link.txt"))
  expect(await execute(root, "ls", { path: "." }, signal)).toBe("link.txt\nreadme.txt")
  expect(await execute(root, "read", { path: "readme.txt" }, signal)).toBe("Nexus fixture")
  for (const path of ["link.txt", "../outside.txt", join(fixture, "outside.txt")]) {
    await expect(execute(root, "read", { path }, signal)).rejects.toThrow("outside")
  }
})

test("read accepts a 64 KiB regular UTF-8 file and rejects oversized, non-text or cancelled reads", async () => {
  const path = join(root, "text")
  await writeFile(path, "a".repeat(65536))
  expect((await execute(root, "read", { path }, signal)).length).toBe(65536)
  await writeFile(path, "a".repeat(65537))
  await expect(execute(root, "read", { path }, signal)).rejects.toThrow("limit")
  await writeFile(path, new Uint8Array([255]))
  await expect(execute(root, "read", { path }, signal)).rejects.toThrow()
  await expect(execute(root, "read", { path: "." }, signal)).rejects.toThrow("regular")
  await expect(execute(root, "read", { path }, AbortSignal.abort())).rejects.toThrow()
})

test("new installation restores unpaired and rejects a project containing the credential store", async () => {
  const runtime = new NexusRuntime(join(root, "credentials"))
  await runtime.restore()
  expect(runtime.status().state).toBe("unpaired")
  await expect(
    runtime.pair({ origin: "http://localhost", directory: root, model: "test/text", workspace: "" }),
  ).rejects.toThrow("credential store")
  await expect(
    runtime.pair({ origin: "https://wrong.invalid/path", directory: root, model: "test/text", workspace: "" }),
  ).rejects.toThrow("origin")
  await runtime.close()
})

test("writes and disjoint edits record exact patches for the owning task", async () => {
  const added = await mutate(root, "write", { path: "lib/example", content: "alpha β gamma" }, signal)
  expect(added.structured_content.change.status).toBe("added")
  const edited = await mutate(
    root,
    "edit",
    {
      path: "lib/example",
      edits: [
        { oldText: "alpha", newText: "gamma" },
        { oldText: "gamma", newText: "alpha" },
      ],
    },
    signal,
  )
  expect(edited.structured_content.change.patch).toContain("+gamma β alpha")
  await expect(
    mutate(root, "edit", { path: "lib/example", edits: [{ oldText: "a", newText: "" }] }, signal),
  ).rejects.toThrow("exactly once")
  expect(await execute(root, "read", { path: "lib/example" }, signal)).toBe("gamma β alpha")
  await symlink(fixture, join(root, "link"))
  await expect(mutate(root, "write", { path: "link/new/file", content: "escape" }, signal)).rejects.toThrow("outside")
})

test("retained checkpoints survive restart, preserve later edits and create an undo for restoration", async () => {
  const { Checkpoints } = await import("../src/checkpoints")
  const directory = join(fixture, "history")
  const history = new Checkpoints(directory, root)
  const path = join(root, "a.txt")
  await writeFile(path, "initial")
  const result = await mutate(root, "write", { path, content: "change" }, signal, (change) =>
    history.save("run", "write", change),
  )
  const recovered = new Checkpoints(directory, root)
  const hash = result.metadata!.checkpoint.hash
  expect((await recovered.records("run")).structured_content.records).toEqual([
    { hash, store: root, present: true, task_key: "write" },
  ])
  await writeFile(path, "user edit")
  await expect(recovered.restore(hash, "undo", "one", signal)).rejects.toThrow("changed")
  expect(await Bun.file(path).text()).toBe("user edit")
  await writeFile(path, "change")
  const undo = await recovered.restore(hash, "undo", "two", signal)
  expect(await Bun.file(path).text()).toBe("initial")
  await recovered.restore(undo.metadata.checkpoint.hash, "redo", "three", signal)
  expect(await Bun.file(path).text()).toBe("change")
  await expect(recovered.restore("../other", "x", "x", signal)).rejects.toThrow("Unknown")
})

test("the web reader keeps a literal site and blocks private and reserved destinations", async () => {
  const { webFetch, webSite } = await import("../src/web")
  expect(webSite("https://EXAMPLE.test:443/a")).toBe("https://EXAMPLE.test:443")
  for (const url of ["https://me@example.org", "file:///tmp/data", "https://*.example.com"])
    expect(() => webSite(url)).toThrow()
  for (const url of [
    "http://localhost",
    "http://127.0.0.1",
    "http://[::1]",
    "http://169.254.169.254/",
    "http://[::ffff:127.0.0.1]",
    "http://10.1.2.3",
  ])
    await expect(
      webFetch(url, signal, async () => {
        throw new Error("Unexpected upload")
      }),
    ).rejects.toThrow("public")
})

test("web content renders HTML as Markdown and preserves complete binary or truncated results as attachments", async () => {
  const { renderWebContent } = await import("../src/web")
  const uploaded = new Map<string, Blob>()
  const publish = async (file: Blob, name: string) => {
    uploaded.set(name, file)
    return { type: "resource_link", name, uri: "nexus://uploads/example" }
  }
  const html = Buffer.from("<h1>Title</h1><p>caf\xe9</p><script>hidden()</script>", "latin1")
  expect((await renderWebContent(html, "text/html; charset=iso-8859-1", publish)).content).toBe("# Title\n\ncafé")
  const plain = "data".repeat(20000)
  expect((await renderWebContent(Buffer.from(plain), "text/plain", publish)).content).toMatchObject([
    { type: "text", text: plain.slice(0, 65536) },
    { name: "web-response.txt" },
  ])
  expect(await uploaded.get("web-response.txt")?.text()).toBe(plain)
  const data = Buffer.from([0, 255, 42])
  expect((await renderWebContent(data, "application/octet-stream", publish)).content).toMatchObject([
    { name: "web-response.bin" },
  ])
  expect(await uploaded.get("web-response.bin")?.bytes()).toEqual(new Uint8Array(data))
})

test("code can call only the captured catalog and routes file work through Nexus", async () => {
  const { runCode } = await import("../src/code")
  const declarations = ["read", "code"].map((name) => ({
    function: { name },
    route: { kind: "runner", tool_name: name },
  }))
  const calls: unknown[] = []
  const result = await runCode(
    "return await tools.read({path:params.path})",
    { path: "readme.txt" },
    declarations,
    async (_, request) => {
      calls.push(request)
      return { status: "completed", content: [{ type: "text", text: "Nexus fixture" }] }
    },
    signal,
  )
  expect(result).toBe('"Nexus fixture"')
  expect(calls).toEqual([{ kind: "tool", name: "read", input: { path: "readme.txt" } }])
  await expect(
    runCode('return await tools.code({code:"return 1"})', {}, declarations, async () => null, signal),
  ).rejects.toThrow()
})
