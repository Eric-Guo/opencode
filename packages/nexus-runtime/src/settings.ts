import { mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Schema } from "effect"
import { Toolsets } from "@cybros/agent"
import { NexusSettings } from "@opencode/schema/nexus-settings"
import { atomic, missing } from "./storage"

const Settings = Schema.Struct({
  origin: Schema.String,
  identifier: Schema.String,
  directory: Schema.String,
  workspace: Schema.String,
  model: Schema.String,
})

export type Settings = typeof Settings.Type
export async function readConnectionSettings(directory: string) {
  const text = await readFile(join(directory, "settings.json"), "utf8").catch((error) => {
    if (missing(error)) return undefined
    throw error
  })
  return text ? Schema.decodeUnknownSync(Schema.fromJsonString(Settings))(text) : undefined
}

export const defaultSettings: NexusSettings.Values = {
  default_model: null,
  fallback_models: [],
  kernel_tools: Toolsets.names(
    "orchestration",
    "conversation",
    "history",
    "memory",
    "discovery",
    "skills",
    "images",
    "schedules",
  ),
  subagent_default: true,
  adaptations: "auto",
  adaptations_dir: null,
  conversation_title_model: "follow_current",
}

export class ApplicationSettings {
  private value = defaultSettings
  private loaded = false
  private queue = Promise.resolve()

  constructor(private readonly path: string) {}

  async restore() {
    if (this.loaded) return
    const text = await readFile(this.path, "utf8").catch((error) => {
      if (missing(error)) return null
      throw error
    })
    this.value = text ? Schema.decodeUnknownSync(Schema.fromJsonString(NexusSettings.Values))(text) : defaultSettings
    this.loaded = true
  }

  read() {
    return structuredClone(this.value)
  }

  change(patch: NexusSettings.Patch, validate: (value: NexusSettings.Values) => Promise<void>) {
    const pending = this.queue.then(async () => {
      const value = Schema.decodeUnknownSync(NexusSettings.Values)({ ...this.value, ...patch })
      await validate(value)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await atomic(this.path, value)
      this.value = value
      return this.read()
    })
    this.queue = pending.then(
      () => {},
      () => {},
    )
    return pending
  }
}
