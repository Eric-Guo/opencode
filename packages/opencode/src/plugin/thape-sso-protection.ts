import type { Hooks } from "@opencode-ai/plugin"
import { API_KEY_ENV_NAMES } from "@opencode-ai/core/thape-sso"

const REDACTED = "[REDACTED]"

export async function ThapeSsoProtection(): Promise<Hooks> {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "read") return
      if (typeof output.args?.filePath !== "string" || !output.args.filePath.includes(".env")) return
      throw new Error("Reading .env files is disabled to protect API keys")
    },
    "shell.env": async (input, output) => {
      if (!input.sessionID) return
      for (const name of API_KEY_ENV_NAMES) output.env[name] = ""
    },
    "tool.execute.after": async (_input, output) => {
      const secrets = API_KEY_ENV_NAMES.flatMap((name) => {
        const value = typeof Bun === "undefined" ? process.env[name] : (Bun.env[name] ?? process.env[name])
        return value ? [value] : []
      })
      if (secrets.length === 0) return
      output.title = redactString(output.title, secrets)
      output.output = redactString(output.output, secrets)
      output.metadata = redact(output.metadata, secrets)
    },
  }
}

export function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]))
}

function redactString(value: string, secrets: readonly string[]) {
  return secrets.reduce((result, secret) => result.replaceAll(secret, REDACTED), value)
}
