import { expect, test } from "bun:test"
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { DefaultEnvironment } from "../src/default-environment"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"
import { skillsExtension } from "../src/skills"
import { processesExtension } from "../src/processes"

test.skipIf(process.platform === "win32")(
  "live default root changes refresh skills while process ownership and accepted directories survive",
  async () => {
    await using dir = await tmpdir()
    const storage = await realpath(dir.path)
    const one = join(storage, "one")
    const two = join(storage, "two")
    await Promise.all([
      mkdir(join(one, ".agents/skills/first"), { recursive: true }),
      mkdir(join(two, ".agents/skills/second"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(
        join(one, ".agents/skills/first/SKILL.md"),
        "---\nname: first\ndescription: first skill\n---\nfirst body",
      ),
      writeFile(
        join(two, ".agents/skills/second/SKILL.md"),
        "---\nname: second\ndescription: second skill\n---\nsecond body",
      ),
    ])
    const environment = new DefaultEnvironment(join(storage, "environment.json"), [join(storage, "private")])
    await environment.restore(one)
    const manager = new ExtensionManager(
      new Configuration(join(storage, "configuration.json")),
      [skillsExtension(join(storage, "absent-guide")), processesExtension(storage)],
      one,
      new AbortController().signal,
      async () => {},
    )
    const ctx = {
      workspace: "workspace",
      conversation: "conversation",
      run: "run",
      task: "task",
      directory: one,
      signal: new AbortController().signal,
    }
    try {
      await manager.start()
      const start = manager.tools().find((tool) => tool.definition.name === "start_process")!
      await start.execute({ command: "printf 'ready\\n'; read line", wait_for: "ready" }, ctx)
      const oldDocument = manager.readDocument("first", ctx, "runner")
      await environment.change(two, (root, persist) => manager.setDirectory(root, persist))
      expect(String((await oldDocument).content)).toContain("first body")
      expect(manager.documents().map((row) => row.name)).toEqual(["second"])
      expect(await manager.command("processes", {})).toMatchObject({
        processes: [{ id: "p1", workdir: one, status: "running" }],
      })
      expect(environment.root).toBe(two)
      expect(environment.source).toBe("api")
      const restored = new DefaultEnvironment(join(storage, "environment.json"), [])
      expect(await restored.restore(one)).toBe(two)
      await expect(
        environment.change(one, (root) =>
          manager.setDirectory(root, async () => {
            throw new Error("announce failed")
          }),
        ),
      ).rejects.toThrow("announce failed")
      expect(environment.root).toBe(two)
      expect(manager.documents().map((row) => row.name)).toEqual(["second"])
      expect(JSON.parse(await readFile(join(storage, "environment.json"), "utf8"))).toEqual({ root: two })
      await environment.change(null, (root, persist) => manager.setDirectory(root, persist))
      expect(environment.root).toBe(one)
      expect(environment.source).toBe("settings")
      expect(manager.documents().map((row) => row.name)).toEqual(["first"])
      expect(await restored.restore(one)).toBe(one)
      await mkdir(join(storage, "private"))
      await symlink(join(storage, "private"), join(storage, "alias"))
      await expect(environment.change(join(storage, "alias"), async (_root, persist) => persist())).rejects.toThrow(
        "protected root",
      )
    } finally {
      await manager.close()
    }
  },
)
