import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initRepo } from "../../core/test/fixture/git"
import { CheckpointStore } from "../src/checkpoint-store"

const signal = new AbortController().signal

test("complete checkpoints deduplicate runs and restore binary files, modes, symlinks with durable undo", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "nexus-tree-")))
  const root = join(fixture, "project")
  await mkdir(root)
  const history = new CheckpointStore(join(fixture, "history"), root)
  try {
    await writeFile(join(root, "binary"), Buffer.from([0, 255, 2]))
    await writeFile(join(root, "script"), "#!/bin/sh\necho before\n")
    await chmod(join(root, "script"), 0o755)
    await symlink("binary", join(root, "link"))
    await mkdir(join(root, "nested"))
    await initRepo(join(root, "nested"))
    await writeFile(join(root, "nested", "file"), "nested before")
    const before = await history.capture("run", "first", signal)
    await writeFile(join(root, "binary"), "later")
    await writeFile(join(root, "script"), "changed")
    await chmod(join(root, "script"), 0o644)
    await writeFile(join(root, "added"), "added")
    await writeFile(join(root, "nested", "file"), "nested later")
    expect(await history.capture("run", "second", signal)).toEqual(before)
    const recovered = new CheckpointStore(join(fixture, "history"), root)
    const restored = await recovered.restore(before.hash, "undo", "restore", signal)
    expect(await readFile(join(root, "binary"))).toEqual(Buffer.from([0, 255, 2]))
    expect((await stat(join(root, "script"))).mode & 0o111).not.toBe(0)
    expect(await readlink(join(root, "link"))).toBe("binary")
    expect(await Bun.file(join(root, "nested", "file")).text()).toBe("nested later")
    expect(await Bun.file(join(root, "added")).exists()).toBe(false)
    expect((await recovered.records("undo"))[0].hash).toBe(restored!.metadata.checkpoint.hash)
    await recovered.restore(restored!.metadata.checkpoint.hash, "redo", "restore", signal)
    expect(await Bun.file(join(root, "binary")).text()).toBe("later")
    expect(await Bun.file(join(root, "added")).text()).toBe("added")
    expect(await recovered.prune(Date.now() + 8 * 86400000)).toBe(3)
    expect(await recovered.restore(before.hash, "gone", "restore", signal)).toBeUndefined()
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("capture honors ignore/protected roots and refuses uncaptured restore obstructions without losing undo", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "nexus-tree-")))
  const root = join(fixture, "project")
  await mkdir(root)
  const history = new CheckpointStore(join(fixture, "history"), root, {
    maxFileBytes: 100,
    maxTreeBytes: 1000,
    protectedRoots: [join(root, "private")],
  })
  try {
    await writeFile(join(root, ".gitignore"), "ignored\n")
    await writeFile(join(root, "ignored"), "ignore this")
    await mkdir(join(root, "private"))
    await writeFile(join(root, "private", "secret"), "private")
    await writeFile(join(root, "file"), "before")
    const before = await history.capture("before", "capture", signal)
    expect(before.files).toBe(2)
    await rm(join(root, "file"))
    await mkdir(join(root, "file"))
    await writeFile(join(root, "file", "oversized"), "a".repeat(101))
    const refusal = await history.restore(before.hash, "undo", "restore", signal)
    expect(refusal).toMatchObject({
      is_error: true,
      content: expect.stringContaining("uncaptured"),
      metadata: { checkpoint: { store: history.id } },
    })
    expect(await Bun.file(join(root, "file", "oversized")).text()).toBe("a".repeat(101))
    expect(await history.records("undo")).toHaveLength(1)
    expect(await Bun.file(join(root, "ignored")).text()).toBe("ignore this")
    const small = new CheckpointStore(join(fixture, "other"), root, { maxTreeBytes: 1 })
    await expect(small.capture("budget", "capture", signal)).rejects.toThrow("budget")
    expect(await small.records("budget")).toEqual([])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("write observation correlates once after failure and freezes cumulative review with outside and ignored marks", async () => {
  const { Checkpoints } = await import("../src/checkpoints")
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "nexus-observe-")))
  const root = join(fixture, "project")
  await mkdir(root)
  const history = new Checkpoints(join(fixture, "history"), root)
  try {
    await writeFile(join(root, "file"), "before\n")
    await expect(
      history.observe("run", "failed", { path: join(fixture, "outside") }, signal, async () => {
        throw new Error("handler failed")
      }),
    ).rejects.toThrow("handler failed")
    const result = await history.observe("run", "success", {}, signal, async () => {
      await writeFile(join(root, "file"), "after\n")
      return { content: "changed" }
    })
    expect(result.metadata?.checkpoint).toMatchObject({ store: history.id, outside: [join(fixture, "outside")] })
    expect(JSON.stringify(result.metadata?.["rho.changes"])).toContain("+after")
    const later = await history.observe("run", "next", {}, signal, async () => {
      await writeFile(join(root, "file"), "latest\n")
      return { content: "changed again" }
    })
    expect(later.metadata?.checkpoint).toBeUndefined()
    expect(later.metadata?.["rho.changes"]).toMatchObject({ files: [{ patch: expect.stringContaining("+latest") }] })
    expect(JSON.stringify(result.metadata?.["rho.changes"])).toContain("+after")
    await writeFile(join(root, ".gitignore"), "ignored\n")
    const ignored = await history.observe("ignored-run", "write", { path: "ignored" }, signal, async () => ({
      content: "done",
    }))
    expect(ignored.metadata?.checkpoint).toMatchObject({ ignored: ["ignored"] })
    const normal = await history.observe("new-run", "write", { path: "new-file" }, signal, async () => ({
      content: "done",
    }))
    expect(normal.metadata?.checkpoint).not.toHaveProperty("ignored")
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("checkpoint budgets apply to changed candidates and preserve large tracked files", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "nexus-budget-")))
  const root = join(fixture, "project")
  await mkdir(root)
  const history = new CheckpointStore(join(fixture, "history"), root, { maxFileBytes: 10, maxTreeBytes: 25 })
  try {
    await writeFile(join(root, "first"), "a".repeat(10))
    await writeFile(join(root, "second"), "b".repeat(10))
    await history.capture("first", "capture", signal)
    await writeFile(join(root, "third"), "c".repeat(10))
    const second = await history.capture("second", "capture", signal)
    expect(second.files).toBe(3)
    await writeFile(join(root, "first"), "a".repeat(20))
    const grown = await history.capture("grown", "capture", signal)
    expect(grown.files).toBe(3)
    expect(grown.skipped).toEqual([])
    await writeFile(join(root, "huge-new"), "d".repeat(20))
    const skipped = await history.capture("skipped", "capture", signal)
    expect(skipped.skipped).toEqual(["huge-new"])
    await writeFile(join(root, "second"), "b".repeat(26))
    await expect(history.capture("over", "capture", signal)).rejects.toThrow("budget")
    expect(await history.records("over")).toEqual([])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test("operator checkpoint queries discover historical roots and compare recorded trees without a workspace", async () => {
  const { Checkpoints } = await import("../src/checkpoints")
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "nexus-discovery-")))
  const root = join(fixture, "first")
  const secondRoot = join(fixture, "second")
  await mkdir(root)
  await mkdir(secondRoot)
  const history = new Checkpoints(join(fixture, "history"), root)
  const second = history.forRoot(secondRoot)
  try {
    await writeFile(join(root, "file"), "before")
    const before = await history.capture("before", "write", signal)
    await writeFile(join(root, "file"), "after")
    const after = await history.capture("after", "write", signal)
    await second.capture("other", "write", signal)
    const corrupt = join(fixture, "history", "0000000000000000")
    await mkdir(corrupt)
    await writeFile(join(corrupt, "checkpoints.sqlite3"), "not a database")
    expect(await CheckpointStore.discover(join(fixture, "history"), "0000000000000000")).toEqual([])
    const rows = await second.query({}, signal)
    expect(rows.structured_content).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({ root }),
        expect.objectContaining({ root: secondRoot }),
      ]),
    })
    expect(await second.query({ store: history.id, checkpoint: before.hash }, signal)).toMatchObject({
      structured_content: { changed: [{ status: "M", path: "file" }] },
    })
    const selected = await second.forStore(history.id)
    const restored = await selected!.restore(before.hash, "undo", "restore", signal)
    expect(restored).toMatchObject({ structured_content: { restored: before.hash, files: 1, removed: 0 } })
    expect(await Bun.file(join(root, "file")).text()).toBe("before")
    await rm(root, { recursive: true })
    expect(await second.query({ store: history.id, from: before.hash, to: after.hash }, signal)).toMatchObject({
      structured_content: { changed: [{ status: "M", path: "file" }] },
    })
    expect((await second.query({ store: history.id, run_public_id: "undo" }, signal)).is_error).toBeUndefined()
    expect(await second.prune(Date.now() + 8 * 86400000)).toBe(4)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
