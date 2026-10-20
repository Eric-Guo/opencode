import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, symlink } from "node:fs/promises"
import { build } from "vite"
import { mainConfig, nodePrelude, pluginRuntimePlugin } from "../vite.node.config"
import { nodeTarget } from "../src/node/target"
import { isolatedEnv } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

test("Node plugins share the host Effect and Zod modules across public entrypoints", async () => {
  await using temporary = await tmpdir()
  const plugin = path.join(temporary.path, "plugin")
  await mkdir(path.join(plugin, "node_modules"), { recursive: true })
  await Promise.all(
    ["effect", "zod"].map((name) =>
      symlink(
        path.dirname(Bun.resolveSync(`${name}/package.json`, import.meta.dirname)),
        path.join(plugin, "node_modules", name),
        "junction",
      ),
    ),
  )
  await Bun.write(
    path.join(plugin, "index.mjs"),
    `export { Effect, Schema } from "effect"
export { succeed } from "effect/Effect"
export { HttpClient } from "effect/http"
export { SchemaCompiler } from "effect/schema"
export { z } from "zod"
export { string } from "zod/v4"`,
  )
  const entry = path.join(temporary.path, "entry.mjs")
  await Bun.write(
    entry,
    `export { Effect, Schema } from ${JSON.stringify(import.meta.resolve("effect"))}
export { HttpClient } from ${JSON.stringify(import.meta.resolve("effect/http"))}
export { SchemaCompiler } from ${JSON.stringify(import.meta.resolve("effect/schema"))}
export { z } from ${JSON.stringify(import.meta.resolve("zod"))}`,
  )
  const input = {
    version: "test",
    channel: "test",
    assetHash: "test",
    target: nodeTarget(process.platform, process.arch),
  }
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [pluginRuntimePlugin()],
    ssr: { noExternal: true },
    build: {
      ...mainConfig(input).build,
      ssr: entry,
      outDir: path.join(temporary.path, "assets", "cli"),
    },
  })
  await Bun.write(
    path.join(temporary.path, "opencode.mjs"),
    `${nodePrelude(input)}
const host = await import("./assets/cli/index.mjs")
const plugin = await import("./plugin/index.mjs")
const { default: assert } = await import("node:assert/strict")
assert.equal(plugin.Effect, host.Effect)
assert.equal(plugin.Schema, host.Schema)
assert.equal(plugin.succeed, host.Effect.succeed)
assert.equal(plugin.HttpClient, host.HttpClient)
assert.equal(plugin.SchemaCompiler, host.SchemaCompiler)
assert.equal(plugin.z, host.z)
assert.equal(plugin.string, host.z.string)
assert.equal(await host.Effect.runPromise(plugin.Schema.decodeUnknownEffect(host.Schema.String)("shared")), "shared")`,
  )
  const child = Bun.spawn({
    cmd: ["node", path.join(temporary.path, "opencode.mjs")],
    env: isolatedEnv(temporary.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  const error = await new Response(child.stderr).text()

  expect(await child.exited, error).toBe(0)
})
