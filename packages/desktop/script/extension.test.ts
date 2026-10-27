import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import { desktopExtension } from "./extension"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test.each([
  { asset: "shared.wasm", contents: "host asset", conflict: false },
  { asset: "fonts/shared.woff2", contents: "host asset", conflict: false },
  { asset: "shared.wasm", contents: "different extension asset", conflict: true },
  { asset: "fonts/shared.woff2", contents: "different extension asset", conflict: true },
])("merges extension assets into the renderer: %j", async ({ asset, contents, conflict }) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "desktop-extension-assets-")))
  directories.push(directory)

  await Promise.all([
    Bun.write(join(directory, "index.html"), '<!doctype html><script type="module" src="/entry.ts"></script>'),
    Bun.write(join(directory, "entry.ts"), 'document.title = "host"'),
    Bun.write(join(directory, "public/assets", asset), "host asset"),
    Bun.write(join(directory, "extension/assets", asset), contents),
    Bun.write(join(directory, "extension/assets/agent.js"), 'document.title = "agent"'),
    Bun.write(
      join(directory, "extension/agent.html"),
      '<!doctype html><script type="module" src="../assets/agent.js"></script>',
    ),
    Bun.write(
      join(directory, "desktop-extension.json"),
      JSON.stringify({
        apiVersion: 1,
        main: "entry.ts",
        renderer: "entry.ts",
        preload: "entry.ts",
        preloads: {},
        assets: { assets: "extension/assets", "sigma-agents/agent.html": "extension/agent.html" },
      }),
    ),
  ])

  const result = build({
    configFile: false,
    root: directory,
    base: "./",
    logLevel: "silent",
    plugins: [desktopExtension(directory)!.assetsPlugin],
    build: { outDir: join(directory, "output") },
  })

  if (conflict) {
    await expect(result).rejects.toThrow(`Conflicting desktop extension asset: ${join("assets", asset)}`)
    expect(await Bun.file(join(directory, "output/assets", asset)).text()).toBe("host asset")
    expect(await Bun.file(join(directory, "output/sigma-agents/agent.html")).exists()).toBe(false)

    return
  }

  await result

  expect(await Bun.file(join(directory, "output/assets", asset)).text()).toBe("host asset")
  const html = Bun.file(join(directory, "output/sigma-agents/agent.html"))
  const script = (await html.text()).match(/src="([^"]+)"/)![1]!
  expect(await Bun.file(new URL(script, pathToFileURL(html.name))).text()).toBe('document.title = "agent"')
})
