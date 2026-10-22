// SAFETY: This module owns validation of untrusted settings IPC and persisted JSON.
/* oxlint-disable anti-slop/no-unknown-parameters */
import { Option, Schema } from "effect"
import type { DesktopProxyResult, DesktopProxySettings, DesktopProxyStatus } from "../extension"
import type { StateStore } from "./storage/state"

const Settings = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("default") }),
  Schema.Struct({ mode: Schema.Literal("direct") }),
  Schema.Struct({ mode: Schema.Literal("manual"), url: Schema.String, bypass: Schema.String }),
])

const Record = Schema.Struct({ settings: Settings, applied: Settings })

const initial: DesktopProxySettings = { mode: "default" }

const name = "opencode.proxy"

const key = "settings"

export function parseProxySettings(input: unknown): DesktopProxySettings | undefined {
  const settings = Option.getOrUndefined(Schema.decodeUnknownOption(Settings)(input))

  return settings && normalize(settings)
}

function normalize(settings: DesktopProxySettings): DesktopProxySettings | undefined {
  if (settings.mode !== "manual") return settings
  const value = settings.url.trim()

  // Check the raw URL too: parsing removes dot segments and empty user-info prefixes.
  if (!/^https?:\/\/[^/@?#\\\s]+\/?$/i.test(value) || !URL.canParse(value)) return undefined
  const url = new URL(value)

  if (!url.hostname || url.port === "0") return undefined
  const bypass = [...new Set(settings.bypass.split(/[,;\s]+/).filter(Boolean))]

  // Accept host names, IPs and optional ports, not Chromium directives that undo loopback bypass.
  if (bypass.some((item) => !/^(\*|(?:\*?\.)?[\w.-]+(?::\d+)?|\[[\da-f:]+\](?::\d+)?|::1)$/i.test(item)))
    return undefined

  return { mode: "manual", url: url.origin, bypass: bypass.join(",") }
}

/** A dedicated, synchronously flushed state writer makes a successful save durable. */
export function createProxySettings(state: Pick<StateStore, "get" | "set" | "flush">) {
  const read = () => {
    const raw = state.get(name, key)

    if (raw === null) return { settings: initial, applied: initial }
    const record = Schema.decodeUnknownSync(Schema.fromJsonString(Record))(raw)
    const settings = normalize(record.settings)
    const applied = normalize(record.applied)

    if (!settings || !applied) throw new Error("Invalid stored proxy settings")

    return { settings, applied }
  }

  const active = read().settings

  const write = (record: { settings: DesktopProxySettings; applied: DesktopProxySettings }) => {
    state.set(name, key, JSON.stringify(record))
    state.flush()
  }

  const get = (): DesktopProxyStatus => {
    const record = read()

    return {
      settings: record.settings,
      restartRequired: !same(record.settings, active) || !same(record.applied, active),
    }
  }

  return {
    active,
    get,
    set(input: unknown): DesktopProxyResult {
      const settings = parseProxySettings(input)

      if (!settings) return { ok: false, error: "invalid" }

      try {
        write({ ...read(), settings })

        return { ok: true, value: get() }
      } catch {
        return { ok: false, error: "storage" }
      }
    },
    pending: () => !same(read().applied, active),
    applied: () => write({ ...read(), applied: active }),
  }
}

function same(left: DesktopProxySettings, right: DesktopProxySettings) {
  return JSON.stringify(left) === JSON.stringify(right)
}
