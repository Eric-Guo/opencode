import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { conventions, conventionsExtension } from "../src/conventions"
import { ExtensionManager } from "../src/extension-manager"
import { Configuration } from "../src/configuration"

test("conventions pay for nearby instructions first and render general instructions before specific ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-conventions-"))
  const root = join(directory, "project")
  const child = join(root, "child")
  const home = join(directory, "home")
  try {
    await Promise.all([mkdir(child, { recursive: true }), mkdir(home)])
    await Promise.all([
      Bun.write(join(child, "AGENTS.md"), "nearest 日本語"),
      Bun.write(join(root, "AGENTS.md"), "project rules"),
      Bun.write(join(root, "CLAUDE.md"), "additional project rules"),
      Bun.write(join(home, "AGENTS.md"), "standing rules"),
      Bun.write(join(directory, "AGENTS.md"), "outside root"),
    ])
    const full = (await conventions(child, root, home))!
    expect(full).not.toContain("outside root")
    expect(full.indexOf("standing rules")).toBeLessThan(full.indexOf("project rules"))
    expect(full.indexOf("project rules")).toBeLessThan(full.indexOf("nearest 日本語"))
    const bounded = (await conventions(
      child,
      root,
      home,
      Buffer.byteLength(`--- ${join(child, "AGENTS.md")} ---\nnearest 日本語`),
    ))!
    expect(bounded).toContain("nearest 日本語")
    expect(bounded).not.toContain("standing rules")
    expect(bounded).toContain("more bytes of AGENTS.md omitted")
    expect(bounded).not.toContain("�")
    await rm(join(child, "AGENTS.md"))
    expect(await conventions(child, root, home)).not.toContain("nearest")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("captured editor capabilities add buffer guidance without a durable port credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-editor-conventions-"))
  const manager = new ExtensionManager(
    new Configuration(join(directory, "settings.json")),
    [conventionsExtension()],
    directory,
    new AbortController().signal,
    async () => {},
  )
  try {
    await manager.start()
    expect(
      await manager.describeEnvironment({
        root: directory,
        "opencode.environment": { root: directory, fs: { client: "editor", read: true, write: true } },
      }),
    ).toContain("The editor's open buffers are what read, edit and write see")
    expect(await manager.describeEnvironment({ root: directory, "opencode.environment": { root: directory } })).toBe("")
  } finally {
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  }
})
