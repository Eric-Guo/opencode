import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"
import { Effect, Layer, Stream } from "effect"
import { SkillPlugin } from "@opencode/core/plugin/skill"
import { Skill } from "@opencode/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(Skill.node))
const config = (plugins: Info["plugins"] = []) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () => Effect.succeed([new Document({ type: "document", info: new Info({ plugins }) })]),
      changes: () => Stream.never,
    }),
  )

describe("SkillPlugin.Plugin", () => {
  it.effect("registers built-in skills", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* SkillPlugin.Plugin.effect(
        host({
          app: { name: "test", version: "1.2.3", channel: "beta" },
          skill: {
            list: () => Effect.die("unused skill.list"),
            transform: skill.transform,
            reload: skill.reload,
          },
        }),
      ).pipe(Effect.provide(config()))
      const skills = yield* skill.list()

      expect(skills).toContainEqual(
        expect.objectContaining({
          id: "opencode",
          name: "OpenCode",
          description: expect.stringContaining("any question about OpenCode itself"),
        }),
      )
    }),
  )
})
