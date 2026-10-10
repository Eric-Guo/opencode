import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pkg from "../package.json"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(failure = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "desktop-prebuild-")))
  directories.push(directory)

  await Promise.all([
    ...["prebuild", "build-extension", "extension", "utils", "copy-icons", "copy-metainfo"].map((name) =>
      Bun.write(join(directory, "desktop/scripts", `${name}.ts`), Bun.file(new URL(`./${name}.ts`, import.meta.url))),
    ),
    Bun.write(
      join(directory, "desktop/package.json"),
      JSON.stringify({
        type: "module",
        scripts: { prebuild: pkg.scripts.prebuild, build: pkg.scripts.build },
        devDependencies: { electron: pkg.devDependencies.electron },
      }),
    ),
    Bun.write(join(directory, "desktop/icons/prod/icon.txt"), "icon fixture"),
    Bun.write(join(directory, "desktop/resources/fixture.txt"), "resources"),
    Bun.write(join(directory, "desktop/index.html"), '<!doctype html><script type="module" src="./entry.ts"></script>'),
    Bun.write(join(directory, "desktop/entry.ts"), 'document.title = "host fixture"'),
    Bun.write(
      join(directory, "desktop/electron.vite.config.ts"),
      `import { desktopExtension } from "./scripts/extension"
export default {
  renderer: {
    root: import.meta.dirname,
    plugins: [desktopExtension()?.assetsPlugin],
    build: { outDir: "out/renderer", rollupOptions: { input: "index.html" } },
  },
}
`,
    ),
    Bun.write(
      join(directory, "extension/desktop-extension.json"),
      JSON.stringify({
        apiVersion: 1,
        main: "../desktop/entry.ts",
        renderer: "../desktop/entry.ts",
        preload: "../desktop/entry.ts",
        preloads: {},
        builds: { "../agents": "build:shared" },
        assets: { "sigma-agents": "../agents/dist-shared/sigma-agents", assets: "../agents/dist-shared/assets" },
      }),
    ),
    Bun.write(join(directory, "agents/package.json"), JSON.stringify({ scripts: { "build:shared": "bun build.ts" } })),
    Bun.write(join(directory, "agents/source.txt"), "first build"),
    Bun.write(
      join(directory, "agents/build.ts"),
      `import { appendFileSync } from "node:fs"
appendFileSync("../steps", "shared\\n")
if (${failure}) process.exit(23)
const source = await Bun.file("source.txt").text()
await Bun.write("dist-shared/sigma-agents/agent.html", source)
await Bun.write("dist-shared/assets/shared.txt", process.env.RUST_TARGET ?? "missing target")
`,
    ),
  ])

  await symlink(
    await realpath(new URL("../node_modules", import.meta.url)),
    join(directory, "desktop/node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  )

  return directory
}

async function build(directory: string, extension = "../extension") {
  const child = Bun.spawn([process.execPath, "run", "build"], {
    cwd: join(directory, "desktop"),
    env: {
      ...process.env,
      OPENCODE_CHANNEL: "prod",
      OPENCODE_DESKTOP_EXTENSION: extension,
      RUST_TARGET: "x86_64-pc-windows-msvc",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  return { code, log: stdout + stderr }
}

test("desktop build prepares missing shared assets and rebuilds them once on every invocation", async () => {
  const directory = await fixture()

  for (const source of ["first build", "updated source"]) {
    await Bun.write(join(directory, "agents/source.txt"), source)
    const result = await build(directory)
    expect(result.code, result.log).toBe(0)
    expect(await Bun.file(join(directory, "desktop/out/renderer/sigma-agents/agent.html")).text()).toBe(source)
    expect(await Bun.file(join(directory, "desktop/out/renderer/assets/shared.txt")).text()).toBe(
      "x86_64-pc-windows-msvc",
    )
  }

  expect(await Bun.file(join(directory, "steps")).text()).toBe("shared\nshared\n")
}, 30000)

test.each(["", "none"])(
  "base desktop builds without preparing extension assets: %s",
  async (extension) => {
    const directory = await fixture()
    const result = await build(directory, extension)
    expect(result.code, result.log).toBe(0)
    expect(await Bun.file(join(directory, "desktop/out/renderer/index.html")).exists()).toBe(true)
    expect(await Bun.file(join(directory, "steps")).exists()).toBe(false)
  },
  30000,
)

test("failed shared build stops the desktop build before it replaces existing output", async () => {
  const directory = await fixture(true)
  await Bun.write(join(directory, "desktop/out/renderer/index.html"), "previous build")
  const result = await build(directory)
  expect(result.code).not.toBe(0)
  expect(result.log).toContain("Desktop extension build failed: ../agents (23)")
  expect(await Bun.file(join(directory, "desktop/out/renderer/index.html")).text()).toBe("previous build")
})
