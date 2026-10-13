export * as Skill from "./skill.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { FSUtil } from "@opencode/util/fs-util"
import path from "path"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@opencode/schema/skill"
import { Bus } from "./bus.js"
import { Permission } from "./permission.js"
import { State } from "./state.js"
import { BuiltinSkill } from "./skill/builtin.js"
import { ReadToolFileSystem } from "./tool/read-filesystem.js"
import { AbsolutePath } from "./schema.js"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = Skill.Source

export const Info = Skill.Info
export type Info = Skill.Info
export const ID = Skill.ID
export type ID = Skill.ID
export const Name = Skill.Name
export type Name = Skill.Name

export { Event } from "@opencode/schema/skill"

export const available = (skills: ReadonlyArray<Info>, permissions: Permission.Ruleset) =>
  skills.filter((skill) => Permission.evaluate("skill", skill.id, permissions).effect !== "deny")

export const toModelOutput = (skill: Info, files: ReadonlyArray<string>) => {
  const directory = path.dirname(skill.path)
  const builtin = BuiltinSkill.resources(skill.path) !== undefined
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    ...(builtin
      ? [
          `Bundled resource directory for this skill (in memory): ${directory}`,
          `Load references and scripts with the skill tool using id="${skill.id}" and file="<relative path>".`,
          "These resources are not filesystem paths; do not use read or shell to open them.",
          "For links to another skill, use that skill's ID and a path relative to its resource directory.",
          "Script resources are snippets to pass to Figma's MCP tools.",
        ]
      : [
          `Base directory for this skill: ${directory}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
        ]),
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${builtin ? path.relative(directory, file) : file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

export class ResourceNotFoundError extends Schema.TaggedError<ResourceNotFoundError>()("Skill.ResourceNotFoundError", {
  skill: ID,
  file: Schema.String,
}) {
  override get message() {
    return `Bundled resource not found for skill ${this.skill}: ${this.file}`
  }
}

export const prepare = Effect.fn("Skill.prepare")(function* (
  fs: FSUtil.Interface,
  skill: Info,
  file?: string,
  page: ReadToolFileSystem.PageInput = {},
) {
  const directory = path.dirname(skill.path)
  const bundled = BuiltinSkill.resources(skill.path)
  if (file !== undefined) {
    const resource = path.resolve(directory, file)
    if (!bundled?.includes(resource)) return yield* new ResourceNotFoundError({ skill: skill.id, file })

    const content = yield* ReadToolFileSystem.readText(
      AbsolutePath.make(resource),
      resource,
      BuiltinSkill.read(resource)!,
      page,
    )

    return {
      directory,
      output: [
        `<skill_resource name="${skill.name}" file="${path.relative(directory, resource)}" offset="${content.offset}">`,
        content.content,
        "</skill_resource>",
        ...(content.next === undefined
          ? []
          : [
              `More content is available. Call skill with id="${skill.id}", file="${path.relative(directory, resource)}", and offset=${content.next}.`,
            ]),
      ].join("\n"),
    }
  }

  const files =
    bundled ??
    (path.basename(skill.path) === "SKILL.md"
      ? yield* fs.scan("**/*", { cwd: directory, absolute: true, include: "file", dot: true })
      : [])

  return {
    directory,
    output: toModelOutput(
      skill,
      files
        .filter((file) => path.basename(file) !== "SKILL.md")
        .toSorted()
        .slice(0, 10),
    ),
  }
})

export type Data = {
  skills: Map<ID, Types.DeepMutable<Info>>
}

export type Editor = {
  list: () => readonly Types.DeepMutable<Info>[]
  get: (id: string) => Types.DeepMutable<Info> | undefined
  add: (skill: Info) => void
  update: (id: string, update: (skill: Types.DeepMutable<Info>) => void) => void
  remove: (id: string) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = State.create<Data, Editor>({
      name: "skill",
      initial: () => ({ skills: new Map() }),
      editor: (editor) => ({
        list: () => Array.from(editor.skills.values()),
        get: (id) => editor.skills.get(ID.make(id)),
        add: (skill) => {
          editor.skills.set(skill.id, { ...skill } as Types.DeepMutable<Info>)
        },
        update: (id, update) => {
          const current = editor.skills.get(ID.make(id))
          if (!current) return
          update(current)
          current.id = ID.make(id)
        },
        remove: (id) => {
          editor.skills.delete(ID.make(id))
        },
      }),
      notify: () => bus.publish(Skill.Event.Updated, {}).pipe(Effect.asVoid),
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("Skill.get")(function* (id) {
        return state.get().skills.get(id)
      }),
      list: Effect.fn("Skill.list")(function* () {
        return Array.from(state.get().skills.values())
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node],
})
