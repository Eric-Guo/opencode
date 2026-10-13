export * as FigmaSkillBundle from "./bundle.js"

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { SkillFile } from "../../config/plugin/skill-file.js"
import files from "./skills-bundle.json" with { type: "json" }

export const revision = createHash("sha256").update(JSON.stringify(files)).digest("hex")

// Real files let the read tool and referenced scripts use the same paths in source and compiled releases.
export async function materialize(directory: string) {
  await Promise.all(
    files.map(async (file) => {
      const target = path.join(directory, file.path)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(file.content, "base64"))
    }),
  )

  return files
    .filter((file) => file.path.endsWith("/SKILL.md"))
    .map((file) => {
      const parsed = SkillFile.parse(
        directory,
        path.join(directory, file.path),
        Buffer.from(file.content, "base64").toString("utf8"),
      )
      if (parsed._tag === "Skipped") throw new Error(`Invalid bundled Figma skill: ${file.path}`)
      return parsed.skill
    })
}
