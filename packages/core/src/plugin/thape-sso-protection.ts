export * as ThapeSsoProtection from "./thape-sso-protection"

import { define, type Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect } from "effect"
import { API_KEY_ENV_NAMES } from "../thape-sso"

export const ID = "opencode.protection.thape-sso"
export const REDACTED = "[REDACTED]"

export const Plugin = define({
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
          if (event.status === "error") {
            event.error = redact(event.error, secrets)
            return
          }
          event.result = {
            ...(event.result.output === undefined ? {} : { output: redact(event.result.output, secrets) }),
            ...(event.result.content === undefined
              ? {}
              : {
                  content:
                    typeof event.result.content === "string"
                      ? redactString(event.result.content, secrets)
                      : event.result.content.map((item) => redactContent(item, secrets)),
                }),
            ...(event.result.metadata === undefined ? {} : { metadata: redact(event.result.metadata, secrets) }),
          }
        }),
      )
      .pipe(Effect.asVoid)
  }),
})

function redactContent(content: Tool.Content, secrets: readonly string[]): Tool.Content {
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
  if (value instanceof Tool.Error)
    return new Tool.Error({
      message: redactString(value.message, secrets),
      ...(value.error === undefined ? {} : { error: redact(value.error, secrets) }),
      ...(value.metadata === undefined ? {} : { metadata: redact(value.metadata, secrets) }),
    }) as Value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)])) as Value
}

function redactString(value: string, secrets: readonly string[]) {
  return secrets.reduce((result, secret) => result.replaceAll(secret, REDACTED), value)
}
