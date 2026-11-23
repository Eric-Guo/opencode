import type { CallbackResult, Client, Run, UploadRef } from "@cybros/agent"
import { Schema } from "effect"

const Unreadable = Schema.Struct({ status: Schema.Literals([403, 404, 410]) })
const Link = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
})

/** Explicit committed captures only; prose paths and unrelated active variants are never publications. */
export async function publishedArtifacts(
  client: Client,
  workspace: string,
  input: { run?: string | Run | null; results?: readonly CallbackResult[] },
  signal?: AbortSignal,
) {
  const seen = new Set<string>()
  const files = new Map<string, UploadRef>()
  const scope = client.workspace(workspace)
  const collect = async (source: string | Run | null | undefined, results: readonly CallbackResult[]) => {
    const run = typeof source === "string" ? source : source?.public_id
    if (run && !seen.has("run:" + run)) {
      seen.add("run:" + run)
      const current = scope.run(run)
      const data = typeof source === "object" && source ? source : await current.fetch({ signal })
      const completed = data.tasks.filter((task) => task.status === "completed" && !task.result?.is_error)
      const image = completed
        .filter((task) => !task.target && ["image_generate", "nexus.image.generate"].includes(task.tool_name ?? ""))
        .map((task) => task.key)
      const children = image.length
        ? (await current.graph({ signal })).nodes
            .filter((node) => node.expansion_parent && image.includes(node.expansion_parent))
            .map((node) => node.key)
        : []
      const published = completed.filter((task) => task.tool_name === "file_publish" && task.target?.kind !== "mcp")
      const generated = completed.filter((task) => task.workload === "image_generation" && children.includes(task.key))
      for (const task of [...published, ...generated]) {
        const content = (await current.task(task.key).fetch({ signal })).content
        for (const block of Array.isArray(content) ? content : []) {
          const link = Schema.decodeUnknownOption(Link)(block)
          if (
            link._tag === "None" ||
            !link.value.uri.startsWith("nexus://uploads/") ||
            (task.tool_name !== "file_publish" && !link.value.mimeType.startsWith("image/"))
          )
            continue
          const id = link.value.uri.slice("nexus://uploads/".length)
          if (!id || id.includes("/") || id.includes("?") || files.has(id)) continue
          files.set(id, {
            public_id: id,
            filename: link.value.name,
            content_type: link.value.mimeType,
            byte_size: link.value.size,
          })
        }
      }
    }
    for (const result of results) {
      const identity = [result.conversation_public_id, result.turn_public_id, result.variant_public_id].join(":")
      if (seen.has(identity)) continue
      seen.add(identity)
      await (async () => {
        const turns = scope.conversation(result.conversation_public_id).turns
        const turn = await turns.fetch(result.turn_public_id, {}, { signal })
        const variant =
          turn.active_variant?.public_id === result.variant_public_id
            ? turn.active_variant
            : (await turns.variant(result.turn_public_id, result.variant_public_id, { signal })).variant
        if (variant.status !== "completed" || variant.details_pruned_at) return
        await collect(
          variant.run_public_id,
          turn.callback_sources.map((source) => source.result),
        )
      })().catch((error: unknown) => {
        // A caller may load the SDK from a separate installation.
        if (Schema.is(Unreadable)(error)) return
        throw error
      })
    }
  }
  await collect(input.run, input.results ?? [])
  return [...files.values()]
}
