import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { realpath, stat, symlink } from "node:fs/promises"
import path from "node:path"
import { brotliDecompressSync } from "node:zlib"
import { AppArchive } from "../src/app-archive"
import { tmpdir } from "./fixture/tmpdir"

test("concurrent app archives preserve web output and precache their own assets", async () => {
  await using temporary = await tmpdir()
  const root = path.join(temporary.path, "packages/app")

  await Promise.all([
    ...["app-assets", "files"].map((name) =>
      Bun.write(
        path.join(temporary.path, "packages/cli/script", `${name}.ts`),
        Bun.file(new URL(`../script/${name}.ts`, import.meta.url)),
      ),
    ),
    Bun.write(
      path.join(temporary.path, "packages/cli/src/app-archive.ts"),
      `export { AppArchive } from ${JSON.stringify(path.resolve(import.meta.dirname, "../src/app-archive.ts"))}`,
    ),
    Bun.write(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { build: "vite build" } })),
    Bun.write(path.join(root, "index.html"), '<html><body><script type="module" src="./main.ts"></script></body></html>'),
    Bun.write(path.join(root, "main.ts"), "document.title = import.meta.env.VITE_OPENCODE_VERSION"),
    Bun.write(path.join(root, "dist/web.txt"), "existing web build"),
    Bun.write(
      path.join(root, "vite.config.ts"),
      `import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import app from ${JSON.stringify(path.resolve(import.meta.dirname, "../../app/vite.config.ts"))}
export default {
  ...app,
  root: import.meta.dirname,
  publicDir: false,
  plugins: [app.plugins, {
    name: "record-output",
    configResolved(config) {
      appendFileSync(${JSON.stringify(path.join(temporary.path, "outputs.jsonl"))}, JSON.stringify(resolve(config.root, config.build.outDir)) + "\\n")
      if (process.env.VITE_OPENCODE_VERSION === "failed") throw new Error("fixture build failed")
    },
  }],
}`,
    ),
    Bun.write(
      path.join(temporary.path, "build.ts"),
      `import { strict } from "node:assert"
import { buildAppArchive } from "./packages/cli/script/app-assets"
await Promise.all(["first", "second"].map(async (version) => {
  await Bun.write(version + ".bin", await buildAppArchive("dev", version))
}))
await strict.rejects(buildAppArchive("dev", "failed"), /Failed with exit code/)
`,
    ),
  ])
  await symlink(
    await realpath(new URL("../../app/node_modules", import.meta.url)),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  )

  const child = Bun.spawn([process.execPath, "run", "build.ts"], {
    cwd: temporary.path,
    env: { ...process.env, SENTRY_AUTH_TOKEN: undefined, VITE_OPENCODE_TEST_FIXTURES: undefined },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(code, stdout + stderr).toBe(0)
  expect(await Bun.file(path.join(root, "dist/web.txt")).text()).toBe("existing web build")

  for (const version of ["first", "second"]) {
    const files = AppArchive.decode(await Bun.file(path.join(temporary.path, `${version}.bin`)).bytes())
    const script = Object.keys(files).find((key) => key.startsWith("_assets/") && key.endsWith(".js"))
    const worker = brotliDecompressSync(files["sw.js"]).toString()

    if (!script) throw new Error("Missing app bundle")

    expect(brotliDecompressSync(files[script]).toString()).toContain(version)
    expect(worker).toContain(script)
    expect(worker).toContain(`sha256-${createHash("sha256").update(brotliDecompressSync(files[script])).digest("base64")}`)
    expect(Object.keys(files).some((key) => key.endsWith(".map"))).toBe(false)
    expect(files["web.txt"]).toBeUndefined()
  }

  const outputs = (await Bun.file(path.join(temporary.path, "outputs.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string)

  expect(new Set(outputs).size).toBe(3)
  await Promise.all(outputs.map(async (directory) => expect(await stat(directory).catch(() => undefined)).toBeUndefined()))
})
