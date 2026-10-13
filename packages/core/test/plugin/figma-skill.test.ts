import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Agent } from "@opencode/core/agent"
import { FigmaSkillPlugin } from "@opencode/core/plugin/figma-skill"
import { Skill } from "@opencode/core/skill"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FigmaSkillBundle } from "@opencode/core/plugin/figma-skill/bundle"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { readInitial } from "../lib/instructions"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Skill.node, SkillInstructions.node, FSUtil.node])))
const source = fileURLToPath(new URL("../../../plugins/figma/skills/", import.meta.url))

describe("built-in Figma skills", () => {
  it.effect("advertises all skills to build and plan without registering MCP and preserves overrides", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const registry = yield* Skill.Service
      const instructions = yield* SkillInstructions.Service
      const fs = yield* FSUtil.Service
      const skills = yield* Effect.promise(() => FigmaSkillBundle.materialize(path.join(directory.path, "override")))
      const override = { ...skills[0], description: "User override" }

      yield* registry.transform((editor) => editor.add(override))
      yield* FigmaSkillPlugin.Plugin.effect(
        host({
          skill: {
            list: () => Effect.die("unused skill.list"),
            transform: registry.transform,
            reload: registry.reload,
          },
        }),
      ).pipe(Effect.provideService(Global.Service, Global.make({ cache: directory.path })))

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
      expect(prepared.directory).toBe(
        path.join(directory.path, "skills", "figma", FigmaSkillBundle.revision, "figma-use-figjam"),
      )
    }),
  )

  test.each(["bun", "node"] as const)(
    "%s release restores every vendored file byte-for-byte",
    async (target) => {
      await using directory = await tmpdir()
      const entrypoint = path.join(directory.path, "entry.ts")
      await Bun.write(
        entrypoint,
        `import { FigmaSkillBundle } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@opencode/core/plugin/figma-skill/bundle")))}
const skills = await FigmaSkillBundle.materialize(process.argv[2])
console.log(JSON.stringify(skills.map((skill) => ({ id: skill.id, path: skill.path }))))
`,
      )
      const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: source, onlyFiles: true }))).toSorted()
      const outfile = path.join(directory.path, target === "bun" ? "figma-test" : "figma-test.js")
      const result = await Bun.build({
        entrypoints: [entrypoint],
        target,
        ...(target === "bun" ? { compile: { outfile } } : { outdir: directory.path, naming: "figma-test.js" }),
      })
      expect(result.success).toBe(true)
      const extracted = path.join(directory.path, "extracted", "skills")
      const child = Bun.spawn(target === "bun" ? [outfile, extracted] : ["node", outfile, extracted], {
        cwd: directory.path,
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      expect(error).toBe("")
      expect(await child.exited).toBe(0)
      expect(JSON.parse(output)).toHaveLength(14)
      expect(
        (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: extracted, onlyFiles: true }))).toSorted(),
      ).toEqual(files)

      await Promise.all(
        files.map(async (file) => {
          expect(await Bun.file(path.join(extracted, file)).bytes()).toEqual(
            await Bun.file(path.join(source, file)).bytes(),
          )
        }),
      )
    },
    60_000,
  )
})
