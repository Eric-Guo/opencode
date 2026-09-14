import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { createPluginSources } from "../src/source.js"

async function fixture(files: Record<string, string>) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-source-")))
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await writeFile(path.join(directory, file), content)
    }),
  )
  return {
    directory,
    entrypoint: pathToFileURL(path.join(directory, "index.mjs")).href,
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  }
}

function client(watch?: (file: string) => Promise<void>) {
  const watched = new Set<string>()
  const sources = createPluginSources(async (file) => {
    watched.add(file)
    await watch?.(file)
  })
  return { ...sources, watched, [Symbol.dispose]: sources.dispose }
}

describe("plugin sources", () => {
  it("reuses the same module and dependency graph across repeated Location disposal", async () => {
    await using plugin = await fixture({
      "index.mjs": 'export { payload } from "./helper.mjs"',
      "helper.mjs": "export const payload = new Array(100_000).fill(123456)",
    })
    using first = client()
    const original = await first.read(plugin.entrypoint)
    first.dispose()

    for (let i = 0; i < 40; i++) {
      using next = client()
      const loaded = await next.read(plugin.entrypoint)
      assert.equal(loaded.module, original.module)
      assert.equal(loaded.version, original.version)
      assert.deepEqual(
        next.watched,
        new Set(["index.mjs", "helper.mjs"].map((file) => path.join(plugin.directory, file))),
      )
    }
  })

  it("joins concurrent preparations and evaluations from multiple Locations", async () => {
    await using plugin = await fixture({
      "index.mjs": `
        import { appendFile } from "node:fs/promises"
        await appendFile(new URL("./evaluations", import.meta.url), "x")
        await new Promise(resolve => setTimeout(resolve, 25))
        export { value } from "./helper.mjs"
      `,
      "helper.mjs": "export const value = {}",
    })
    using first = client()
    using second = client()
    const loaded = await Promise.all([
      first.read(plugin.entrypoint),
      second.read(plugin.entrypoint),
      first.read(plugin.entrypoint),
    ])
    assert.equal(loaded[0].module, loaded[1].module)
    assert.equal(loaded[0].version, loaded[1].version)
    assert.equal(loaded[0].module, loaded[2].module)
    assert.deepEqual(first.watched, second.watched)
    assert.equal(await readFile(path.join(plugin.directory, "evaluations"), "utf8"), "x")
  })

  it("refreshes an edited dependency once, including edits while no Location is active", async () => {
    await using plugin = await fixture({
      "index.mjs": 'export { value } from "./helper.mjs"',
      "helper.mjs": "export const value = 1",
    })
    using first = client()
    using second = client()
    const original = await first.read(plugin.entrypoint)
    await second.read(plugin.entrypoint)
    await writeFile(path.join(plugin.directory, "helper.mjs"), "export const value = 2")
    const updated = await Promise.all([first.read(plugin.entrypoint), second.read(plugin.entrypoint)])
    assert.notEqual(updated[0].version, original.version)
    assert.equal(updated[0].module, updated[1].module)
    assert.equal(updated[0].version, updated[1].version)
    assert.equal((updated[0].module as { value: number }).value, 2)
    first.dispose()
    second.dispose()

    await writeFile(path.join(plugin.directory, "helper.mjs"), "export const value = 3")
    using next = client()
    const recreated = await next.read(plugin.entrypoint)
    assert.notEqual(recreated.version, updated[0].version)
    assert.equal((recreated.module as { value: number }).value, 3)
    assert.equal((await next.read(plugin.entrypoint)).module, recreated.module)
  })

  it("shares failed evaluations and retries after a dependency is repaired", async () => {
    await using plugin = await fixture({
      "index.mjs": 'export { value } from "./helper.mjs"',
      "helper.mjs": `
        import { appendFile } from "node:fs/promises"
        await appendFile(new URL("./evaluations", import.meta.url), "x")
        throw new Error("broken helper")
        export const value = 1
      `,
    })
    using first = client()
    using second = client()
    await Promise.all([
      assert.rejects(first.read(plugin.entrypoint), /broken helper/),
      assert.rejects(second.read(plugin.entrypoint), /broken helper/),
    ])
    first.dispose()
    second.dispose()

    using next = client()
    await assert.rejects(next.read(plugin.entrypoint), /broken helper/)
    assert.equal(await readFile(path.join(plugin.directory, "evaluations"), "utf8"), "x")
    await writeFile(path.join(plugin.directory, "helper.mjs"), "export const value = 2")
    assert.equal(((await next.read(plugin.entrypoint)).module as { value: number }).value, 2)
  })

  it("detects dependency edits while an earlier evaluation is still pending", async () => {
    await using plugin = await fixture({
      "index.mjs": `
        import { setTimeout } from "node:timers/promises"
        export { value } from "./helper.mjs"
        await setTimeout(100)
      `,
      "helper.mjs": "export const value = 1",
    })
    const tracked = Promise.withResolvers<void>()
    using first = client(async (file) => {
      if (file === path.join(plugin.directory, "helper.mjs")) tracked.resolve()
    })
    using second = client()
    const original = first.read(plugin.entrypoint)
    await tracked.promise
    await writeFile(path.join(plugin.directory, "helper.mjs"), "export const value = 2")
    const updated = await second.read(plugin.entrypoint)
    assert.notEqual(updated.version, (await original).version)
    assert.equal((updated.module as { value: number }).value, 2)
  })

  it("watches missing dependencies in a recreated Location and recovers when they appear", async () => {
    await using plugin = await fixture({ "index.mjs": 'export { value } from "./helper.mjs"' })
    using first = client()
    await assert.rejects(first.read(plugin.entrypoint))
    first.dispose()

    using next = client()
    await assert.rejects(next.read(plugin.entrypoint))
    assert.ok(next.watched.has(plugin.directory))
    await writeFile(path.join(plugin.directory, "helper.mjs"), "export const value = 1")
    assert.equal(((await next.read(plugin.entrypoint)).module as { value: number }).value, 1)
  })

  it("keeps lazy imports reloadable after disposal without retaining closed Location watchers", async () => {
    await using plugin = await fixture({
      "index.mjs": 'export const load = () => import("./helper.mjs")',
      "helper.mjs": 'export { value } from "./nested/value.mjs"',
      "nested/value.mjs": "export const value = 1",
    })
    using first = client()
    const original = await first.read(plugin.entrypoint)
    first.dispose()
    const closed = new Set(first.watched)
    using second = client()
    using third = client()
    const reused = await second.read(plugin.entrypoint)
    await third.read(plugin.entrypoint)
    assert.equal(reused.module, original.module)
    assert.equal(await (reused.module as { load: () => Promise<{ value: number }> }).load().then((m) => m.value), 1)
    assert.ok(second.watched.has(path.join(plugin.directory, "nested/value.mjs")))
    assert.deepEqual(third.watched, second.watched)
    assert.deepEqual(first.watched, closed)

    await writeFile(path.join(plugin.directory, "nested/value.mjs"), "export const value = 2")
    const updated = await third.read(plugin.entrypoint)
    assert.notEqual(updated.version, original.version)
    assert.equal(await (updated.module as { load: () => Promise<{ value: number }> }).load().then((m) => m.value), 2)
    assert.deepEqual(first.watched, closed)
  })

  it("keeps watcher readiness local when another Location joins the same evaluation", async () => {
    await using plugin = await fixture({ "index.mjs": "export const value = 1" })
    const ready = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    using first = client(() => {
      started.resolve()
      return ready.promise
    })
    using second = client()
    const pending = first.read(plugin.entrypoint)
    await started.promise
    const loaded = await second.read(plugin.entrypoint)
    first.dispose()
    ready.resolve()
    assert.equal((await pending).module, loaded.module)
  })
})
