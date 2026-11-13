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

test("read and code mode respect the same directory binding", async () => {
  await writeFile(join(root, "readme.txt"), "Nexus fixture")
  await writeFile(join(fixture, "outside.txt"), "private")
  await symlink(join(fixture, "outside.txt"), join(root, "link.txt"))
  expect(await execute(root, "ls", { path: "." }, signal)).toBe("link.txt\nreadme.txt")
  expect(await execute(root, "read", { path: "readme.txt" }, signal)).toBe("Nexus fixture")
  for (const path of ["link.txt", "../outside.txt", join(fixture, "outside.txt")]) {
    await expect(execute(root, "read", { path }, signal)).rejects.toThrow("outside")
  }
  expect(await execute(root, "code", { code: 'return await tools.read({path: "readme.txt"})' }, signal)).toBe(
    '"Nexus fixture"',
  )
  await expect(execute(root, "code", { code: 'return await tools.read({path: "link.txt"})' }, signal)).rejects.toThrow()
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
