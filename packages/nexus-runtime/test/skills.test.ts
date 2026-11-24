import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readSkill, scanSkills, skillsExtension } from "../src/skills"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"
import { readWindow } from "../src/file-read"

test("skill scanning keeps source precedence, validates frontmatter and exposes original body offsets", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nexus-skills-")))
  try {
    for (const directory of [
      ".agents/skills/review",
      ".claude/skills/review",
      ".claude/skills/wrong",
      ".agents/skills/nested/child",
      ".agents/skills/empty",
      ".agents/skills/.hidden",
    ])
      await mkdir(join(root, directory), { recursive: true })
    const path = join(root, ".agents/skills/review/SKILL.md")
    await writeFile(path, "---\nname: review\ndescription: Review code\n---\nFirst instruction\nSecond instruction\n")
    await writeFile(join(root, ".claude/skills/review/SKILL.md"), "---\ndescription: duplicate\n---\nOther body")
    await writeFile(
      join(root, ".claude/skills/wrong/SKILL.md"),
      "---\nname: different\ndescription: mismatched\n---\nBody",
    )
    await writeFile(join(root, ".agents/skills/nested/child/SKILL.md"), "---\ndescription: nested\n---\nBody")
    await writeFile(join(root, ".agents/skills/README.md"), "Directory notes")
    await writeFile(join(root, ".agents/skills/.hidden/SKILL.md"), "---\ndescription: hidden\n---\nBody")
    const catalog = await scanSkills(root)
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["review"])
    expect(catalog.skills[0].description).toBe("Review code")
    expect(catalog.skills[0].bodyLine).toBe(5)
    expect((await readWindow(path, new AbortController().signal, catalog.skills[0].bodyLine)).content).toBe(
      "First instruction\nSecond instruction",
    )
    expect(catalog.skipped).toEqual([
      { path: join(root, ".claude/skills/review/SKILL.md"), reason: expect.stringContaining("already announced") },
      { path: join(root, ".claude/skills/wrong/SKILL.md"), reason: expect.stringContaining("match its directory") },
    ])
    for (const name of ["name: null\n", "", "name: review\n"]) {
      await writeFile(path, "---\n" + name + "description: Review code\n---\nBody")
      expect((await readSkill(path)).name).toBe("review")
    }
    for (const name of ["different", "42", "false", "[]", "{}"]) {
      await writeFile(path, "---\nname: " + name + "\ndescription: Review code\n---\nBody")
      await expect(readSkill(path)).rejects.toThrow("Skill name must match")
    }
    await writeFile(path, "---\ndescription: &unsafe [*unsafe]\n---\nBody")
    await expect(readSkill(path)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("skill loads rescan the announced root and fall back to alternate skills and the installed guide", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nexus-skill-load-")))
  const guide = join(root, "guide.md")
  const signal = new AbortController().signal
  const manager = new ExtensionManager(
    new Configuration(join(root, "settings.json")),
    [skillsExtension(guide)],
    root,
    signal,
    async () => {},
  )
  try {
    await mkdir(join(root, ".agents/skills/review"), { recursive: true })
    await mkdir(join(root, ".claude/skills/review"), { recursive: true })
    await writeFile(join(root, ".agents/skills/review/SKILL.md"), "---\ndescription: Preferred\n---\nPrimary")
    await writeFile(join(root, ".claude/skills/review/SKILL.md"), "---\ndescription: Backup\n---\nAlternate")
    await writeFile(guide, "Installed workspace tools")
    await manager.start()
    const context = {
      directory: join(root, "other"),
      workspace: "workspace",
      conversation: "conversation",
      run: "run",
      task: "task",
      signal,
    }
    expect(manager.documents().map((document) => document.name)).toEqual(["review", "workspace-tools"])
    expect((await manager.readDocument("review", context, "runner")).content).toContain("Primary")
    await rm(join(root, ".agents/skills/review"), { recursive: true })
    expect((await manager.readDocument("review", context, "runner")).content).toContain("Alternate")
    expect((await manager.readDocument("workspace-tools", context, "runner")).content).toBe("Installed workspace tools")
    await rm(guide)
    expect(await manager.readDocument("workspace-tools", context, "runner")).toMatchObject({ is_error: true })
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})
