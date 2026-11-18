import { isDeepStrictEqual } from "node:util"
import { APIError, type Client, type MemoryBindings } from "@cybros/agent"
import { Schema } from "effect"

const usage = "Use memory ls [PATH], read PATH, write PATH TEXT, edit JSON, grep PATTERN, or delete PATH."
const Edit = Schema.fromJsonString(
  Schema.Struct({ path: Schema.NonEmptyString, old_text: Schema.NonEmptyString, new_text: Schema.String }),
)

export async function conversationMemory(
  client: Client,
  input: { workspace: string; conversation: string; speaker?: string; command: string },
  signal?: AbortSignal,
) {
  const [, verb = "ls", rest = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input.command.trimStart()) ?? []
  const memory = client.workspace(input.workspace).conversation(input.conversation).memory(input.speaker)
  const options = { signal }
  if (verb === "ls" || verb === "list") {
    const rows = (await memory.list(options)).filter((row) => row.path.startsWith(rest))
    return {
      value: rows,
      text: rows.map((row) => row.path + " (" + row.bytesize + " bytes)").join("\n") || "No memory documents.",
    }
  }
  if (verb === "read" && rest) {
    const row = await memory.read(rest, options)
    return { value: row, text: row.path + "\n" + (row.content ?? "") }
  }
  if (verb === "grep" && rest) {
    const result = await memory.grep({ pattern: rest }, options)
    const lines = result.matches.map((row) => row.path + ":" + row.line_number + ": " + row.text)
    if (result.truncated) lines.push("More matches exist; narrow the pattern.")
    return { value: result, text: lines.join("\n") || "No matches found." }
  }
  const edit = verb === "edit" ? Schema.decodeUnknownOption(Edit)(rest) : undefined
  const write = verb === "write" ? /^(\S+)\s+([\s\S]+)$/.exec(rest) : undefined
  const path = edit?._tag === "Some" ? edit.value.path : (write?.[1] ?? (verb === "delete" ? rest : ""))
  if (!path) throw new Error(usage)

  const current = await memory.read(path, options).catch((error: unknown) => {
    if (
      verb === "write" &&
      error instanceof APIError &&
      ((error.status === 404 && error.code === "memory_not_found") ||
        (error.status === 422 && error.code === "memory_scope_unavailable"))
    )
      return null
    throw error
  })
  const expected_collection_public_id =
    current?.collection_public_id ??
    (await writableMemoryCollection(client, () => memory.bindings(options), path, options))
  const expected = { expected_collection_public_id }

  if (write) {
    const row = await memory.write(
      {
        path,
        content: write[2],
        ...expected,
        expected_public_id: current?.public_id ?? null,
        expected_lock_version: current?.lock_version ?? null,
      },
      options,
    )
    return { value: row, text: "Write completed: " + path }
  }
  if (!current) throw new Error("Memory document not found.")
  const version = { ...expected, expected_public_id: current.public_id, expected_lock_version: current.lock_version }

  if (edit?._tag === "Some") {
    const row = await memory.edit({ ...edit.value, ...version }, options)
    return { value: row, text: "Edit completed: " + path }
  }
  await memory.delete(path, version, options)
  return { value: { path }, text: "Delete completed: " + path }
}

async function writableMemoryCollection(
  client: Client,
  bindings: () => Promise<MemoryBindings>,
  path: string,
  options: { signal?: AbortSignal },
) {
  const root = path.split("/", 1)[0]
  const find = async () => (await bindings()).bindings.find((row) => row.name === root)
  const binding = await find()
  if (!binding || binding.access !== "read_write")
    throw new Error("That memory scope is unavailable or read-only for this requester.")
  if (binding.state === "active" && binding.collection_public_id) return binding.collection_public_id
  if (binding.state !== "unallocated" || binding.source.scope !== "speaker" || !binding.speaker_public_id)
    throw new Error("The selected memory collection is unavailable.")

  const profile = client.profile
  const owner = (await profile.fetch(options)).member.public_id
  const agent =
    owner === binding.owner_public_id
      ? undefined
      : (await profile.agents.list(options)).find((row) => row.public_id === binding.owner_public_id)
  if (owner !== binding.owner_public_id && !agent)
    throw new Error("The answering Agent must initialize its Speaker memory.")

  const collections = agent ? profile.agents.memoryCollections(agent.name) : profile.memoryCollections
  await collections.create({ default: true, speaker_public_id: binding.speaker_public_id }, options)

  const selected = await find()
  if (
    !selected ||
    !isDeepStrictEqual(selected.source, binding.source) ||
    selected.scope !== binding.scope ||
    selected.owner_public_id !== binding.owner_public_id ||
    selected.speaker_public_id !== binding.speaker_public_id
  )
    throw new Error("The memory binding changed while initializing its collection.")
  if (selected.access !== "read_write" || selected.state !== "active" || !selected.collection_public_id)
    throw new Error("The selected memory collection is unavailable.")

  return selected.collection_public_id
}
