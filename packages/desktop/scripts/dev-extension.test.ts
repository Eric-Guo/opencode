import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareDevExtension } from "./dev-extension"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(builds = true, failure = "") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "desktop-dev-extension-")))
  directories.push(directory)
  const root = join(directory, "extension")
  const output = join(directory, "desktop/out/renderer")
  await Promise.all([
    Bun.write(
      join(root, "desktop-extension.json"),
      JSON.stringify({
        apiVersion: 1,
        main: "entry.ts",
        renderer: "entry.ts",
        preload: "entry.ts",
        preloads: {},
        assets: {
          "desktop-tab/tabbar.html": "tabbar.html",
          "7777": "../7777/dist",
          "plm-meeting": "../plm-meeting/dist",
        },
        ...(builds ? { builds: { "../7777": "bundle", "../plm-meeting": "bundle" } } : {}),
      }),
    ),
    Bun.write(join(root, "entry.ts"), "export {}"),
    Bun.write(join(root, "tabbar.html"), "tabbar"),
    ...["7777", "plm-meeting"].map((project) =>
      Bun.write(
        join(directory, project, "package.json"),
        JSON.stringify({ scripts: { bundle: `bun ../build.ts ${project}` } }),
      ),
    ),
    Bun.write(
      join(directory, "build.ts"),
      `import { appendFileSync } from "node:fs"
const project = process.argv[2]
appendFileSync(new URL("./steps", import.meta.url), project + "\\n")
if (project === ${JSON.stringify(failure)}) process.exit(23)
await Bun.write("dist/index.html", project === "7777" ? "agent7777" : "agent-plm-meeting")
`,
    ),
  ])
  return { directory, root, output }
}

test.each(["", "none"])("base desktop skips extension preparation: %s", async (root) => {
  await expect(prepareDevExtension(root)).resolves.toBeUndefined()
})

test("builds missing renderer outputs and replaces the stale meeting bundle before launch", async () => {
  const input = await fixture()
  await Bun.write(join(input.output, "plm-meeting/index.html"), "agent7777")

  await prepareDevExtension(input.root, input.output)

  expect(await readFile(join(input.directory, "steps"), "utf8")).toBe("7777\nplm-meeting\n")
  expect(await readFile(join(input.output, "7777/index.html"), "utf8")).toBe("agent7777")
  expect(await readFile(join(input.output, "plm-meeting/index.html"), "utf8")).toBe("agent-plm-meeting")
  expect(await readFile(join(input.output, "desktop-tab/tabbar.html"), "utf8")).toBe("tabbar")
})

test("stops before copying assets when a renderer build fails", async () => {
  const input = await fixture(true, "7777")
  await Bun.write(join(input.output, "plm-meeting/index.html"), "existing")

  await expect(prepareDevExtension(input.root, input.output)).rejects.toThrow("../7777 (23)")

  expect(await readFile(join(input.directory, "steps"), "utf8")).toBe("7777\n")
  expect(await readFile(join(input.output, "plm-meeting/index.html"), "utf8")).toBe("existing")
})

test("copies prebuilt assets for existing manifests without builds", async () => {
  const input = await fixture(false)
  await Promise.all([
    Bun.write(join(input.directory, "7777/dist/index.html"), "prebuilt main"),
    Bun.write(join(input.directory, "plm-meeting/dist/index.html"), "prebuilt meeting"),
  ])

  await prepareDevExtension(input.root, input.output)

  expect(await readFile(join(input.output, "plm-meeting/index.html"), "utf8")).toBe("prebuilt meeting")
  expect(await Bun.file(join(input.directory, "steps")).exists()).toBe(false)
})
