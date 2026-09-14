import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { rename, rm } from "node:fs/promises"
import { brotliCompressSync } from "node:zlib"
import { build } from "vite"
import { mainConfig, payloadAssetsPlugin, rawTextPlugin } from "../vite.node.config"
import { nodeTarget } from "../src/node/target"
import type { AssetMap } from "../src/app-assets"
import { tmpdir } from "./fixture/tmpdir"

test("loads packaged payloads on demand from split chunks after relocation", async () => {
  await using temporary = await tmpdir()
  const archive = JSON.stringify({
    "index.html": brotliCompressSync("<html>test web payload</html>").toString("base64"),
    "font.woff2": brotliCompressSync(new Uint8Array([0, 1, 2, 255])).toString("base64"),
    "unused.js": "invalid compressed data",
  })
  const entry = path.join(temporary.path, "entry.mjs")
  await Bun.write(
    entry,
    `import { load } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../core/src/models-dev/snapshot.ts"))}
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
    appArchive: archive,
  })
  const outDir = path.join(temporary.path, "built")
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [payloadAssetsPlugin(archive), rawTextPlugin()],
    ssr: { noExternal: true },
    build: { ...config.build, ssr: entry, outDir },
  })
  const relocated = path.join(temporary.path, "relocated with spaces")
  await rename(outDir, relocated)
  await rm(entry)
  await rm(path.join(temporary.path, "optional.mjs"))
  const built = await import(path.join(relocated, "index.mjs"))
  expect(built.catalog().zhipuai).toBeDefined()
  expect(await built.web()).toBe(archive)
  const assets: AssetMap = await Effect.runPromise(built.load())
  expect(assets["index.html"]).toBe("<html>test web payload</html>")
  expect(assets["font.woff2"]).toEqual(new Uint8Array([0, 1, 2, 255]))
  expect(assets["missing.js"]).toBeUndefined()
  expect(() => assets["unused.js"]).toThrow()
  await expect(built.optional()).rejects.toThrow("optional module loaded")
  const files = await Array.fromAsync(new Bun.Glob("*.mjs").scan(relocated))
  expect(files.length).toBeGreaterThan(1)
  const source = (await Promise.all(files.map((file) => Bun.file(path.join(relocated, file)).text()))).join("\n")
  expect(source).not.toContain(archive)
  expect(source).not.toContain('"zhipuai"')
})
