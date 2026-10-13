import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Skill } from "@opencode/core/skill"
import { Config } from "@opencode/core/config"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { SkillTool } from "@opencode/core/tool/plugin/skill"
import { FigmaSkillPlugin } from "@opencode/core/plugin/figma-skill"
import { BuiltinSkill } from "@opencode/core/skill/builtin"
import { host } from "./plugin/host"
import { Tool } from "@opencode/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { Image } from "@opencode/core/image"
import { it } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"
import { registerIntegrationPolicy } from "./fixture/policy"

const skillToolNode = makeLocationNode({
  name: "test/skill-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [Tool.node, FSUtil.node, Skill.node, Permission.node],
})

const sessionID = Session.ID.make("ses_skill_tool_test")

describe("SkillTool", () => {
  it.effect("refuses a policy-blocked skill before authorization or content preparation", () =>
    Effect.gen(function* () {
      const skills = yield* Skill.Service
      const managed = yield* ManagedPolicy.Service
      const tools = yield* Tool.Service
      // This path does not exist; an attempted content scan would fail the test.
      yield* skills.transform((editor) =>
        editor.add(
          Skill.Info.make({
            id: Skill.ID.make("private"),
            name: Skill.Name.make("Private"),
            path: AbsolutePath.make("/unavailable/private/SKILL.md"),
            content: "Private instructions",
          }),
        ),
      )
      yield* managed.set({ statements: [{ action: "integration.use", resource: "skill:private", effect: "deny" }] })
      yield* registerIntegrationPolicy({ skill: skills })
      expect(
        yield* executeTool(tools, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-policy-denied-skill", name: "skill", input: { id: "private" } },
        }),
      ).toEqual({ status: "error", error: { type: "tool.execution", message: "Unable to load skill private" } })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode, Skill.node, Config.node, ManagedPolicy.node]), [
          Config.node.replace(Config.testLayer()),
          Permission.node.replace(permissionLayer({ assert: () => Effect.die("Blocked skill reached authorization") })),
          Image.node.replace(imagePassthrough),
        ]),
      ),
    ),
  )

  it.effect("loads bundled references and scripts from memory with paging and skill authorization", () => {
    const assertions: Permission.AssertInput[] = []

    return Effect.gen(function* () {
      const skills = yield* Skill.Service
      const tools = yield* Tool.Service
      const managed = yield* ManagedPolicy.Service

      yield* FigmaSkillPlugin.Plugin.effect(
        host({
          skill: {
            list: () => Effect.die("unused skill.list"),
            transform: skills.transform,
            reload: skills.reload,
          },
        }),
      )

      const main = yield* executeTool(tools, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-builtin-main", name: "skill", input: { id: "figma-use" } },
      })
      expect(main).toMatchObject({ status: "completed" })
      expect(main.content).toEqual([expect.objectContaining({ text: expect.stringContaining("in memory") })])

      yield* Effect.forEach(
        [
          { id: "figma-use", file: "references/plugin-api-standalone.d.ts" },
          { id: "figma-generate-library", file: "scripts/inspectFileStructure.js" },
          { id: "figma-use", file: "../NOTICE.md" },
        ],
        (input) =>
          Effect.gen(function* () {
            const resource = path.resolve(BuiltinSkill.root, input.id, input.file)
            const result = yield* executeTool(tools, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: `call-builtin-${input.file}`,
                name: "skill",
                input: { ...input, limit: 3 },
              },
            })
            expect(result).toMatchObject({ status: "completed" })
            expect(result.content).toEqual([
              expect.objectContaining({
                text: expect.stringContaining(
                  BuiltinSkill.read(resource)!.toString("utf8").split("\n").slice(0, 3).join("\n"),
                ),
              }),
            ])
            expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("offset=4") })])
          }),
      )

      const next = yield* executeTool(tools, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-builtin-next",
          name: "skill",
          input: { id: "figma-use", file: "references/plugin-api-standalone.d.ts", offset: 4, limit: 3 },
        },
      })
      expect(next).toMatchObject({ status: "completed" })
      expect(next.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining(
            BuiltinSkill.read(path.join(BuiltinSkill.root, "figma-use/references/plugin-api-standalone.d.ts"))!
              .toString("utf8")
              .split("\n")
              .slice(3, 6)
              .join("\n"),
          ),
        }),
      ])
      expect(assertions.map((input) => input.resources)).toEqual([
        ["figma-use"],
        ["figma-use"],
        ["figma-generate-library"],
        ["figma-use"],
        ["figma-use"],
      ])

      yield* Effect.forEach(["references/missing.md", "../figma-shaders/SKILL.md", "../../../../etc/passwd"], (file) =>
        Effect.gen(function* () {
          expect(
            yield* executeTool(tools, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: `call-builtin-invalid-${file}`,
                name: "skill",
                input: { id: "figma-use", file },
              },
            }),
          ).toMatchObject({ status: "error" })
        }),
      )

      yield* managed.set({ statements: [{ action: "integration.use", resource: "skill:figma-use", effect: "deny" }] })
      yield* registerIntegrationPolicy({ skill: skills })
      const authorized = assertions.length

      expect(
        yield* executeTool(tools, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-builtin-denied",
            name: "skill",
            input: { id: "figma-use", file: "references/plugin-api-standalone.d.ts" },
          },
        }),
      ).toMatchObject({ status: "error" })
      expect(assertions).toHaveLength(authorized)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode, Skill.node, Config.node, ManagedPolicy.node]), [
          Config.node.replace(Config.testLayer()),
          Permission.node.replace(
            permissionLayer({
              assert: (input) =>
                Effect.sync(() => {
                  assertions.push(input)
                }),
            }),
          ),
          Image.node.replace(imagePassthrough),
        ]),
      ),
    )
  })

  it.live("lists available skills, authorizes the selected ID, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: Skill.Info = {
            id: Skill.ID.make("effect"),
            name: Skill.Name.make("Effect"),
            description: "Use Effect",
            path: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          const assertions: Permission.AssertInput[] = []
          let deny = false
          const permission = permissionLayer({
            assert: (input) =>
              Effect.sync(() => assertions.push(input)).pipe(
                Effect.andThen(
                  deny
                    ? Effect.fail(
                        new Permission.BlockedError({
                          rules: [],
                          permission: input.action,
                          resources: input.resources,
                        }),
                      )
                    : Effect.void,
                ),
              ),
          })
          const skills = Layer.mock(Skill.Service, {
            get: (id) => Effect.succeed(current.find((skill) => skill.id === id)),
            list: () => Effect.succeed(current),
          })
          const skillToolLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode]), [
            Permission.node.replace(permission),
            Skill.node.replace(skills),
            Image.node.replace(imagePassthrough),
          ])

          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toMatchObject({
              status: "completed",
              content: [{ type: "text", text: Skill.toModelOutput(info, [reference]) }],
            })
            expect(Skill.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({
              status: "completed",
              output: { name: "Effect", directory, output: Skill.toModelOutput(info, [reference]) },
              content: [{ type: "text", text: Skill.toModelOutput(info, [reference]) }],
              metadata: { name: "Effect", directory },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { id: "missing" } },
              }),
            ).toEqual({
              status: "error",
              error: { type: "tool.execution", message: "Unable to load skill missing" },
            })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({
              status: "error",
              error: { type: "permission.rejected", message: "Permission denied: skill" },
            })
            deny = false
            const flat = Skill.Info.make({
              id: Skill.ID.make("public"),
              name: Skill.Name.make("Public"),
              description: "Public guidance",
              path: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.path, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { id: "public" } },
              }),
            ).toMatchObject({
              status: "completed",
              content: [{ type: "text", text: Skill.toModelOutput(flat, []) }],
            })
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})
