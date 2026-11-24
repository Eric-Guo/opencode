import { createReadStream } from "node:fs"
import { Schema } from "effect"
import type { NexusCommand } from "@opencode/protocol/nexus-command"

type Command = Extract<typeof NexusCommand.Type, { action: "persona.read" | "persona.write" | "persona.reset" }>

export async function runPersona(
  args: readonly string[],
  json: boolean,
  manage: (command: Command) => Promise<unknown>,
  stdin: AsyncIterable<Uint8Array> = process.stdin,
) {
  const [action = "show", path] = args
  if (action === "set" && args.length === 2 && path) {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of path === "-" ? stdin : createReadStream(path)) {
      size += chunk.length
      if (size > 65536) throw new Error("Persona exceeds 64 KiB.")
      chunks.push(chunk)
    }
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
    const saved = await manage({ action: "persona.write", content })

    return json ? JSON.stringify(saved, null, 2) + "\n" : "Persona saved.\n"
  }
  if (args.length > 1 || (action !== "show" && action !== "reset"))
    throw new Error("Use opencode nexus persona [show | set FILE | set - | reset].")

  const result = await manage({ action: action === "show" ? "persona.read" : "persona.reset" })
  if (json) return JSON.stringify(result, null, 2) + "\n"
  if (result === null) return "No persona is set.\n"
  if (action === "reset") return "Persona reset.\n"

  const { content } = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }))(result)
  return content.endsWith("\n") ? content : content + "\n"
}
