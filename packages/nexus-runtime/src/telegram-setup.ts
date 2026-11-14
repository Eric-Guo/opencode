import { Schema } from "effect"
import type { JsonValue } from "@cybros/agent"
import type { Nexus } from "@opencode/schema/nexus"
import { TelegramSettings } from "./telegram-settings"

export async function telegramSetup(
  input: JsonValue,
  settings: TelegramSettings,
  configure?: (operations: Nexus.ExtensionChange["operations"]) => Promise<unknown>,
) {
  const value = Schema.decodeUnknownSync(
    Schema.Struct({
      action: Schema.String,
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      enabled: Schema.optional(Schema.Boolean),
      token: Schema.optional(Schema.NullOr(Schema.String)),
      configuration: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    }),
  )(input)
  if (value.action === "telegram.connections")
    return Object.entries(settings.connections).map(([id, row]) => ({
      id,
      name: row.name,
      enabled: row.enabled,
      token_present: !!row.token,
    }))
  if (!["telegram.connection.save", "telegram.connection.remove", "telegram.bot.configure"].includes(value.action))
    return
  if (!configure) throw new Error("Telegram setup needs the extension configuration owner.")
  const raw = { connections: settings.connections, bots: settings.bots }
  if (value.action === "telegram.bot.configure") {
    if (!value.id || !value.configuration) throw new Error("Select a Bot and provide its target configuration.")
    const candidate = { ...settings.bots[value.id], ...value.configuration }
    const validated = new TelegramSettings({ ...raw, bots: { ...raw.bots, [value.id]: candidate } })
    await configure([{ op: "set", path: ["bots", value.id], value: validated.bots[value.id] }])
    return { id: value.id, saved: true }
  }
  if (value.action === "telegram.connection.remove") {
    if (!value.id || !settings.connections[value.id]) throw new Error("Unknown Telegram Connection.")
    if (Object.values(settings.bots).some((row) => row.connection_public_id === value.id))
      throw new Error("Remove this Connection from its Bot targets before deleting it.")
    await configure([{ op: "unset", path: ["connections", value.id] }])
    return { id: value.id, removed: true }
  }
  if (value.token === "")
    throw new Error("Omit token to keep it, provide a nonempty replacement, or use null to clear it.")
  const id = value.id ?? crypto.randomUUID()
  const connection = {
    name: value.name ?? settings.connections[id]?.name ?? "Telegram",
    enabled: value.enabled ?? settings.connections[id]?.enabled ?? true,
    token: value.token === null ? "" : (value.token ?? settings.connections[id]?.token ?? ""),
  }
  const validated = new TelegramSettings({ ...raw, connections: { ...raw.connections, [id]: connection } })
  await configure([{ op: "set", path: ["connections", id], value: validated.connections[id] }])
  return { id, saved: true, token_present: !!connection.token }
}
