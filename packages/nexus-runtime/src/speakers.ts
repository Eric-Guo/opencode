import type { Client, MemorySelection, RequestOptions } from "@cybros/agent"

export const memoryModes = ["full", "index"] as const

/** The application owner is a conversation participant, independent of the Agent credential that submits their words. */
export async function ownerSpeaker(client: Client, agent: string, options?: RequestOptions): Promise<string> {
  return (
    await client.profile.registerIngressSpeaker(
      { channel_key: "rho:" + agent, external_id: "owner", display_name: "Owner" },
      options,
    )
  ).public_id
}

/** Every rho-created conversation binds these natural roots; index mode keeps the assembled directory byte-stable. */
export function memoryContext(input: { audience?: string; mode?: string; speaker?: string } = {}): MemorySelection {
  const audience = input.audience ?? "owner"
  const mode = input.mode ?? "index"

  if (audience !== "owner" && audience !== "external") throw new Error("unknown Bot audience")
  if (mode !== "full" && mode !== "index") throw new Error("unknown memory mode")

  const bindings: MemorySelection["bindings"] = [
    { name: "conversation", source: { scope: "conversation" }, access: "read_write" },
    {
      name: "speaker",
      source: input.speaker ? { scope: "speaker", speaker_public_id: input.speaker } : { scope: "speaker" },
      access: "read_write",
    },
  ]

  if (audience === "owner") bindings.push({ name: "agent", source: { scope: "agent" }, access: "read_write" })
  bindings.push({
    name: "workspace",
    source: { scope: "workspace" },
    access: audience === "external" ? "read" : "read_write",
  })

  const context: MemorySelection = { bindings }

  if (mode === "index") context.mode = "index"
  return context
}
