export * as FigmaSkillPlugin from "./figma-skill.js"

import { define } from "@opencode/plugin/effect/plugin"
import { FigmaSkillBundle } from "./figma-skill/bundle.js"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import path from "node:path"

export const Plugin = define({
  id: "opencode.figma.skills",
  effect: Effect.fn(function* (ctx) {
    const global = yield* Global.Service
    const skills = yield* Effect.promise(() =>
      FigmaSkillBundle.materialize(path.join(global.cache, "skills", "figma", FigmaSkillBundle.revision)),
    )

    yield* ctx.skill.transform((editor) => {
      skills.forEach((skill) => {
        if (!editor.get(skill.id)) editor.add(skill)
      })
    })
  }),
})
