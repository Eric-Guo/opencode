/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import { Flag } from "../flag.js"
import opencodeContent from "./skill/opencode.md" with { type: "text" }
import apiContent from "./skill/opencode-api.md" with { type: "text" }
import { files } from "./skill/opencode/api.js"

export const OpencodeContent = opencodeContent

export const OpencodeDescription =
  "Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app."

export const Plugin = define({
  id: "opencode.skill",
  effect: Effect.fn(function* () {
    const api = yield* Flag.enabled("opencode_api")
    const skills = yield* Skill.Service
    // Skill.Service rather than ctx.skill, whose editor can't add a skill's files.
    yield* skills.transform((editor) => {
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("opencode"),
          name: Skill.Name.make("OpenCode"),
          description: OpencodeDescription,
          path: AbsolutePath.make("skill://opencode/SKILL.md"),
          // With opencode:// fetch, its API section points there instead of the `opencode api` command.
          content: api ? OpencodeContent.replace(/## \[API\][^]*?(?=## \[Client\])/, `${apiContent}\n`) : OpencodeContent,
        }),
        api ? files : undefined,
      )
    })
  }),
})
