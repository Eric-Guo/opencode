import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { WebUIModule } from "../src/webui-module"
import { ExtensionManager } from "../src/extension-manager"
import { Configuration } from "../src/configuration"
import { workerRegistration } from "../src/worker-extension"

test("versioned UI assets are confined to the declared root and retire on disable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-webui-"))
  const root = join(directory, "ui")
  await mkdir(root)
  await Bun.write(join(root, "index.js"), "export function register() {}")
  await Bun.write(join(root, "style.css"), "body {}")
  await Bun.write(
    join(directory, "extension.ts"),
    'import { join } from "node:path"; export async function register(api) { await api.registerWebUI(join(api.directory, "ui")) }',
  )
  await Bun.write(join(directory, "private.txt"), "private")
  await symlink(join(directory, "private.txt"), join(root, "escape.txt"))

  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [
      {
        descriptor: {
          id: "ui.fixture",
          name: "Fixture",
          description: "UI fixture",
          configuration_version: 1,
          default_enabled: true,
          configuration_schema: { type: "object" },
          defaults: {},
        },
        register: workerRegistration(join(directory, "extension.ts")),
      },
    ],
    directory,
    new AbortController().signal,
    async () => {},
  )

  try {
    await manager.start()
    const version = manager.list()[0]!.webui!.version
    expect(Buffer.from((await manager.asset("ui.fixture", version, "index.js")).content, "base64").toString()).toBe(
      "export function register() {}",
    )
    expect((await manager.asset("ui.fixture", version, "style.css")).mime).toBe("text/css")
    await expect(manager.asset("ui.fixture", version, "../private.txt")).rejects.toThrow("outside")
    await expect(manager.asset("ui.fixture", version, "escape.txt")).rejects.toThrow("outside")
    await expect(manager.asset("ui.fixture", "old", "index.js")).rejects.toThrow("no longer active")
    await manager.change({ id: "ui.fixture", enabled: false })
    await manager.close()
    await expect(manager.asset("ui.fixture", version, "index.js")).rejects.toThrow("no longer active")
    await expect(WebUIModule.open("relative/path")).rejects.toThrow("absolute")
  } finally {
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})
