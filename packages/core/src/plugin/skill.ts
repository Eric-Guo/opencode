/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import opencodeContent from "./skill/opencode.md" with { type: "text" }

export const OpencodeContent = opencodeContent

export const OpencodeDescription =
  "Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app."

export const Plugin = define({
  id: "opencode.skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((editor) => {
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("opencode"),
          name: Skill.Name.make("OpenCode"),
          description: OpencodeDescription,
          path: AbsolutePath.make("/builtin/opencode.md"),
          content: OpencodeContent,
        }),
      )
    })
  }),
})
