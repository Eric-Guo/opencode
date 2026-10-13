import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Agent } from "@opencode/core/agent"
import { FigmaSkillPlugin } from "@opencode/core/plugin/figma-skill"
import { Skill } from "@opencode/core/skill"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { BuiltinSkill } from "@opencode/core/skill/builtin"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { readInitial } from "../lib/instructions"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Skill.node, SkillInstructions.node, FSUtil.node])))
const source = fileURLToPath(new URL("../../../plugins/figma/skills/", import.meta.url))

describe("built-in Figma skills", () => {
  it.effect("advertises all skills to build and plan without registering MCP and preserves overrides", () =>
    Effect.gen(function* () {
      const registry = yield* Skill.Service
      const instructions = yield* SkillInstructions.Service
      const fs = yield* FSUtil.Service
      const register = FigmaSkillPlugin.Plugin.effect(
        host({
          skill: {
            list: () => Effect.die("unused skill.list"),
            transform: registry.transform,
            reload: registry.reload,
          },
        }),
      )

      yield* register
      const skills = yield* registry.list()
      const override = { ...skills[0], description: "User override" }

      yield* registry.transform((editor) => editor.add(override))
      yield* register

      expect(yield* registry.list()).toHaveLength(14)
      expect(yield* registry.get(override.id)).toEqual(override)

      yield* Effect.forEach(["build", "plan"], (id) =>
        Effect.gen(function* () {
          const agent = Agent.Info.default(Agent.ID.make(id))
          const guidance = yield* instructions.load(agent.permissions).pipe(Effect.flatMap(readInitial))

          skills.forEach((skill) => expect(guidance.text).toContain(`<id>${skill.id}</id>`))
        }),
      )

      const skill = yield* registry.get(Skill.ID.make("figma-use-figjam"))
      expect(skill).toBeDefined()
      const prepared = yield* Skill.prepare(fs, skill!)
      expect(prepared.output).toContain("references/")
      expect(prepared.directory).toBe(path.join(BuiltinSkill.root, "figma-use-figjam"))
    }),
  )

  test.each(["bun", "node"] as const)(
    "%s release reads every vendored file byte-for-byte from memory without extracting files",
    async (target) => {
      await using directory = await tmpdir()
      const entrypoint = path.join(directory.path, "entry.ts")
      await Bun.write(
        entrypoint,
        `import { BuiltinSkill } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@opencode/core/skill/builtin")))}
import path from "node:path"
console.log(JSON.stringify(BuiltinSkill.paths.map((file) => ({
  path: path.relative(BuiltinSkill.root, file).split(path.sep).join("/"),
  content: BuiltinSkill.read(file).toString("base64"),
}))))
`,
      )
      const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: source, onlyFiles: true }))).toSorted()
      const outfile = path.join(
        directory.path,
        target === "bun" ? (process.platform === "win32" ? "figma-test.exe" : "figma-test") : "figma-test.js",
      )
      const result = await Bun.build({
        entrypoints: [entrypoint],
        target,
        ...(target === "bun" ? { compile: { outfile } } : { outdir: directory.path, naming: "figma-test.js" }),
      })
      expect(result.success).toBe(true)
      const before = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory.path, dot: true }))
      const child = Bun.spawn(target === "bun" ? [outfile] : ["node", outfile], {
        cwd: directory.path,
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      expect(error).toBe("")
      expect(await child.exited).toBe(0)
      expect((await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory.path, dot: true }))).toSorted()).toEqual(
        before.toSorted(),
      )
      expect(JSON.parse(output)).toEqual(
        await Promise.all(
          files.map(async (file) => ({
            path: file.replaceAll("\\", "/"),
            content: Buffer.from(await Bun.file(path.join(source, file)).arrayBuffer()).toString("base64"),
          })),
        ),
      )
    },
    60_000,
  )
})
