import { expect, test } from "bun:test"
import path from "node:path"
import { rename, rm } from "node:fs/promises"
import { brotliCompressSync } from "node:zlib"
import { pathToFileURL } from "node:url"
import { createCipheriv } from "node:crypto"
import { build } from "vite"
import { appArchiveAsset, mainConfig, payloadAssetsPlugin, rawTextPlugin } from "../vite.node.config"
import { sidecarConfig } from "../vite.sidecar.config"
import { nodeTarget } from "../src/node/target"
import { AppArchive } from "../src/app-archive"
import { tmpdir } from "./fixture/tmpdir"

test.each(["build", "build-node"])("%s rejects a missing SSO key before replacing existing output", async (script) => {
  await using temporary = await tmpdir()
  await Bun.write(path.join(temporary.path, "previous.txt"), "previous build")

  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      path.resolve(import.meta.dirname, `../script/${script}.ts`),
      `--outdir=${temporary.path}`,
    ],
    env: { ...process.env, SIGMA_AES_128_ECB_KEY: undefined },
    stdout: "pipe",
    stderr: "pipe",
  })
  const error = await new Response(child.stderr).text()

  expect(await child.exited).not.toBe(0)
  expect(error).toContain("SIGMA_AES_128_ECB_KEY must contain exactly 16 UTF-8 bytes in the build environment")
  expect(await Bun.file(path.join(temporary.path, "previous.txt")).text()).toBe("previous build")
})

test.each(["cli", "sidecar"])(
  "embeds the SSO key in the %s without requiring a runtime environment key",
  async (target) => {
    await using temporary = await tmpdir()
    const key = "0123456789abcdef"
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null)
    const data =
      cipher.update(JSON.stringify({ chinese_name: "测试用户", opencode_api_key: "sso-test-key" }), "utf8", "base64") +
      cipher.final("base64")
    const entry = path.join(temporary.path, "entry.mjs")
    await Bun.write(
      entry,
      `export { ensureSsoUsername } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../thape/src/sso.ts"))}`,
    )
    const config = (target === "cli" ? mainConfig : sidecarConfig)({
      version: "test",
      channel: "test",
      assetHash: "test",
      target: nodeTarget(process.platform, process.arch),
      sigmaKey: key,
    })
    const outDir = path.join(temporary.path, "built")
    await build({
      configFile: false,
      logLevel: "silent",
      define: config.define,
      ssr: { noExternal: true },
      build: {
        ssr: entry,
        outDir,
        rollupOptions: { output: { format: "esm", entryFileNames: "index.mjs" } },
      },
    })
    const child = Bun.spawn({
      cmd: [
        "node",
        "--input-type=module",
        "--eval",
        `import assert from "node:assert/strict"
assert.equal(process.env.SIGMA_AES_128_ECB_KEY, undefined)
const sso = await import(${JSON.stringify(pathToFileURL(path.join(outDir, "index.mjs")).href)})
process.env.THAPE_SSO_BEARER_API_KEY = "test-token"
await sso.ensureSsoUsername(() => Promise.resolve(Response.json({data: ${JSON.stringify(data)}})))
assert.equal(process.env.THAPE_SSO_USER_NAME, "测试用户")
assert.equal(process.env.OPENCODE_API_KEY, "sso-test-key")`,
      ],
      env: {
        ...process.env,
        SIGMA_AES_128_ECB_KEY: undefined,
        THAPE_SSO_USER_NAME: undefined,
        OPENCODE_API_KEY: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const error = await new Response(child.stderr).text()

    expect(await child.exited, error).toBe(0)
  },
)

test.each(["cli", "sidecar"])("bundles the selected release catalog in the %s", async (target) => {
  await using temporary = await tmpdir()
  const snapshot = JSON.stringify({ release: { name: "Selected release catalog" } })
  const entry = path.join(temporary.path, "entry.mjs")
  await Bun.write(
    entry,
    `export { load } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../core/src/models-dev/snapshot.ts"))}`,
  )
  const config = sidecarConfig({
    version: "test",
    channel: "test",
    assetHash: "test",
    modelsSnapshot: snapshot,
    target: nodeTarget(process.platform, process.arch),
  })
  const outDir = path.join(temporary.path, "built")
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: target === "cli" ? [payloadAssetsPlugin(snapshot)] : config.plugins,
    build: {
      ssr: entry,
      ssrEmitAssets: true,
      outDir,
      rollupOptions: { output: { format: "esm", entryFileNames: "index.mjs" } },
    },
  })
  const { load } = await import(pathToFileURL(path.join(outDir, "index.mjs")).href)

  expect(load()).toBe(snapshot)
})

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
