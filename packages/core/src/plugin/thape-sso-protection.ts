export * as ThapeSsoProtection from "./thape-sso-protection"

import type { Context as PluginContext } from "@opencode-ai/plugin/v2/effect/plugin"
import type { LLM } from "@opencode-ai/schema/llm"
import { Effect } from "effect"
import { API_KEY_ENV_NAMES } from "../thape-sso"

export const ID = "opencode.protection.thape-sso"
export const REDACTED = "[REDACTED]"

export const Plugin = {
  id: ID,
  effect: Effect.fn("ThapeSsoProtection.Plugin")(function* (ctx: PluginContext) {
    yield* ctx.tool
      .hook("execute.before", (event) =>
        Effect.sync(() => {
          if (event.tool !== "read") return
          if (!event.input || typeof event.input !== "object" || !("path" in event.input)) return
          if (typeof event.input.path !== "string" || !event.input.path.includes(".env")) return
          throw new Error("Reading .env files is disabled to protect API keys")
        }),
      )
      .pipe(Effect.asVoid)

    yield* ctx.tool
      .hook("execute.after", (event) =>
        Effect.sync(() => {
          const secrets = API_KEY_ENV_NAMES.flatMap((name) => {
            const value = typeof Bun === "undefined" ? process.env[name] : (Bun.env[name] ?? process.env[name])
            return value ? [value] : []
          })
          if (secrets.length === 0) return
          if (event.status === "error") event.error = redact(event.error, secrets)
          if (event.content)
            event.content = [
              redactContent(event.content[0], secrets),
              ...event.content.slice(1).map((item) => redactContent(item, secrets)),
            ]
          if (event.metadata) event.metadata = redact(event.metadata, secrets)
          if (event.outputPaths) event.outputPaths = event.outputPaths.map((item) => redactString(item, secrets))
        }),
      )
      .pipe(Effect.asVoid)
  }),
}

function redactContent(content: LLM.ToolContent, secrets: readonly string[]): LLM.ToolContent {
  if (content.type === "text") return { ...content, text: redactString(content.text, secrets) }
  return {
    ...content,
    uri: redactString(content.uri, secrets),
    mime: redactString(content.mime, secrets),
    ...(content.name ? { name: redactString(content.name, secrets) } : {}),
  }
}

export function redact<Value>(value: Value, secrets: readonly string[]): Value {
  if (typeof value === "string") return redactString(value, secrets) as Value
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets)) as Value
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)])) as Value
}

function redactString(value: string, secrets: readonly string[]) {
  return secrets.reduce((result, secret) => result.replaceAll(secret, REDACTED), value)
}
