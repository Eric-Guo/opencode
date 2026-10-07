import { expect, test } from "bun:test"
import path from "node:path"
import { rename, rm } from "node:fs/promises"
import { brotliCompressSync } from "node:zlib"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import { appArchiveAsset, mainConfig, payloadAssetsPlugin, rawTextPlugin } from "../vite.node.config"
import { nodeTarget } from "../src/node/target"
import { AppArchive } from "../src/app-archive"
import { tmpdir } from "./fixture/tmpdir"

test("loads packaged payloads on demand from split chunks after relocation", async () => {
  await using temporary = await tmpdir()
  const archive = AppArchive.encode([
    ["index.html", brotliCompressSync("<html>test web payload</html>")],
    ["font.woff2", brotliCompressSync(new Uint8Array([0, 1, 2, 255]))],
    ["unused.js", new TextEncoder().encode("invalid compressed data")],
  ])
  const entry = path.join(temporary.path, "entry.mjs")
  await Bun.write(
    entry,
    `import { load } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../core/src/models-dev/snapshot.ts"))}
export { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
export { load } from ${JSON.stringify(path.resolve(import.meta.dirname, "../src/app-assets.ts"))}
export const catalog = () => JSON.parse(load())
export const web = async () => { const { default: load } = await import("virtual:opencode-app-assets"); return load() }
export const optional = () => import("./optional.mjs")`,
  )
  await Bun.write(path.join(temporary.path, "optional.mjs"), 'throw new Error("optional module loaded")')
  const config = mainConfig({
    version: "test",
    channel: "test",
    assetHash: "test",
    target: nodeTarget(process.platform, process.arch),
  })
  const outDir = path.join(temporary.path, "built")
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [payloadAssetsPlugin(), rawTextPlugin()],
    ssr: { noExternal: true },
    build: { ...config.build, ssr: entry, outDir },
  })
  await Bun.write(path.join(outDir, appArchiveAsset), archive)

  const relocated = path.join(temporary.path, "relocated with spaces")
  await rename(outDir, relocated)
  await rm(entry)
  await rm(path.join(temporary.path, "optional.mjs"))
  // The packaged CLI uses node:sea, so exercise its lazy chunks in their actual runtime.
  const child = Bun.spawn({
    cmd: [
      "node",
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict"
import { brotliCompressSync } from "node:zlib"
const built = await import(${JSON.stringify(pathToFileURL(path.join(relocated, "index.mjs")).href)})
assert.ok(built.catalog().zhipuai)
assert.deepEqual(await built.web(), Buffer.from(${JSON.stringify(archive.toString("base64"))}, "base64"))
const assets = await built.Effect.runPromise(built.load())
assert.equal(assets.files["index.html"], "<html>test web payload</html>")
assert.deepEqual(assets.files["font.woff2"], Buffer.from([0, 1, 2, 255]))
assert.equal(assets.files["missing.js"], undefined)
assert.throws(() => assets.files["unused.js"])
assert.deepEqual(Buffer.from(assets.brotli["index.html"]), brotliCompressSync("<html>test web payload</html>"))
await assert.rejects(built.optional(), /optional module loaded/)`,
    ],
    env: { ...process.env, OPENCODE_NODE_ASSETS_DIR: relocated },
    stdout: "pipe",
    stderr: "pipe",
  })
  const error = await new Response(child.stderr).text()

  expect(await child.exited, error).toBe(0)

  const files = await Array.fromAsync(new Bun.Glob("*.mjs").scan(relocated))
  expect(files.length).toBeGreaterThan(1)
  const source = (await Promise.all(files.map((file) => Bun.file(path.join(relocated, file)).text()))).join("\n")
  expect(source).not.toContain(archive.toString("base64"))
  expect(source).not.toContain('"zhipuai"')
})
