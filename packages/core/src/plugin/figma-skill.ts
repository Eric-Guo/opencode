export * as FigmaSkillPlugin from "./figma-skill.js"

import { define } from "@opencode/plugin/effect/plugin"
import { BuiltinSkill } from "../skill/builtin.js"
import { SkillFile } from "../config/plugin/skill-file.js"
import { Effect } from "effect"
import path from "node:path"

export const Plugin = define({
  id: "opencode.figma.skills",
  effect: Effect.fn(function* (ctx) {
    const skills = BuiltinSkill.paths
      .filter((file) => path.basename(file) === "SKILL.md")
      .map((file) => {
        const parsed = SkillFile.parse(BuiltinSkill.root, file, BuiltinSkill.read(file)!.toString("utf8"))
        if (parsed._tag === "Skipped") throw new Error(`Invalid bundled Figma skill: ${file}`)
        return parsed.skill
      })

    yield* ctx.skill.transform((editor) => {
      skills.forEach((skill) => {
        if (!editor.get(skill.id)) editor.add(skill)
      })
    })
  }),
})
