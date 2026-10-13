export * as BuiltinSkill from "./builtin.js"

import path from "node:path"
import files from "../plugin/figma-skill/skills-bundle.json" with { type: "json" }

export const root = path.resolve("/builtin/skills/figma")
const contents = new Map(files.map((file) => [path.join(root, file.path), file.content]))
export const paths = Array.from(contents.keys())

export const read = (filepath: string) => {
  const content = contents.get(filepath)
  return content === undefined ? undefined : Buffer.from(content, "base64")
}

export const resources = (filepath: string) => {
  if (!contents.has(filepath)) return undefined
  const directory = path.dirname(filepath) + path.sep
  return paths.filter((file) => file.startsWith(directory) || file === path.join(root, "NOTICE.md"))
}
