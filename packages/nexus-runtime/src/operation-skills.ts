import { NotFound, type Client, type RequestOptions } from "@cybros/agent"
import { Schema } from "effect"
import type { Environments } from "./environments"

export const SkillOperation = Schema.Union([
  Schema.Struct({ action: Schema.Literal("skills") }),
  Schema.Struct({
    action: Schema.Literals(["skill.show", "skill.remove"]),
    scope: Schema.Literals(["agent", "workspace"]),
    name: Schema.NonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("skill.push"),
    scope: Schema.Literals(["agent", "workspace"]),
    name: Schema.NonEmptyString,
    description: Schema.String,
    content: Schema.String,
  }),
])

/** Read each remote revision once; a conflicting writer is never silently overwritten. */
export async function skillOperation(
  client: Client,
  workspace: string,
  input: typeof SkillOperation.Type,
  options: RequestOptions,
  environments: Environments,
) {
  if (input.action !== "skills" && (input.name.length > 64 || !/^[a-z0-9](?:-?[a-z0-9])*$/.test(input.name)))
    throw new Error("Invalid skill name.")

  const defaultCollection = async (scope: "agent" | "workspace") => {
    const owner = scope === "agent" ? client.profile : client.workspace(workspace)
    return (await owner.memoryCollections.list({ default: true }, options)).items[0]
  }

  if (input.action === "skills") {
    const collections = { agent: await defaultCollection("agent"), workspace: await defaultCollection("workspace") }
    const sections = await Promise.all(
      (["agent", "workspace"] as const).map(async (scope) => {
        const collection = collections[scope]
        const documents = collection ? await client.memoryCollections.documents(collection.public_id).list(options) : []

        return [
          scope,
          documents.filter((row) => row.path.startsWith("skills/")).map((row) => ({ ...row, name: row.path.slice(7) })),
        ]
      }),
    )

    return { ...Object.fromEntries(sections), collections, project: environments.projectDocuments() }
  }
  const collection = await defaultCollection(input.scope)

  if (!collection) throw new Error("The default memory collection is unavailable.")

  const documents = client.memoryCollections.documents(collection.public_id)
  const path = "skills/" + input.name
  const current = await documents.read(path, options).catch((error: unknown) => {
    if (input.action === "skill.push" && error instanceof NotFound && error.code === "memory_not_found") return null

    throw error
  })

  if (input.action === "skill.show") return current
  if (input.action === "skill.remove") {
    if (!current) throw new Error("The skill does not exist.")

    await documents.delete(
      path,
      { expected_public_id: current.public_id, expected_lock_version: current.lock_version },
      options,
    )
    return { deleted: path }
  }

  if (input.action !== "skill.push") throw new Error("Unknown skill operation.")

  return documents.write(
    {
      path,
      content: input.content,
      description: input.description,
      expected_public_id: current?.public_id ?? null,
      expected_lock_version: current?.lock_version ?? null,
    },
    options,
  )
}
