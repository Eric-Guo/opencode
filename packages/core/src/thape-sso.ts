import { Effect } from "effect"
import { Observability } from "@opencode-ai/util/observability"

const SSO_ME_URL = "https://sso.thape.com.cn/api/me.json"
const bun = globalThis as typeof globalThis & { Bun?: { env: Record<string, string | undefined> } }
let hideAgents: string[] = []
let loaded = false

export const API_KEY_ENV_NAMES = [
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "DOC_MOONSHOT_API_KEY",
  "DEEPSEEK_API_KEY",
  "SILICONFLOW_CN_API_KEY",
  "EXA_API_KEY",
  "CEREBRAS_API_KEY",
] as const

function runtimeEnv(key: string) {
  return bun.Bun?.env[key] ?? process.env[key]
}

function log(effect: Effect.Effect<void>) {
  return effect.pipe(
    Effect.annotateLogs({ service: "thape-sso" }),
    Effect.provide(Observability.layer()),
    Effect.scoped,
    Effect.runPromise,
  )
}

function setRuntimeEnv(key: string, value: string) {
  if (bun.Bun) bun.Bun.env[key] = value
  process.env[key] = value
}

function hasValue(value: string | undefined) {
  return typeof value === "string" && value.trim().length > 0
}

export function ssoHideAgents() {
  return hideAgents.slice()
}

export async function ensureSsoUsername() {
  if (loaded && hasValue(runtimeEnv("THAPE_SSO_USER_NAME")) && hasValue(runtimeEnv("OPENCODE_API_KEY"))) return

  const token = runtimeEnv("THAPE_SSO_BEARER_API_KEY")
  if (!token) {
    await log(Effect.logDebug("skipping SSO username lookup; THAPE_SSO_BEARER_API_KEY not set"))
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  const response = await fetch(SSO_ME_URL, {
    method: "OPTIONS",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "JWT-AUD": "opencode",
      Authorization: `Bearer ${token}`,
    },
    signal: controller.signal,
  })
    .catch(async (error) => {
      await log(Effect.logWarning("SSO username request failed", { error }))
      return undefined
    })
    .finally(() => clearTimeout(timeout))
  if (!response) return

  if (!response.ok) {
    await log(
      Effect.logWarning("SSO username request returned non-OK status", {
        status: response.status,
        statusText: response.statusText,
      }),
    )
    return
  }

  const payload = await response
    .json()
    .then(
      (value) =>
        value as {
          chinese_name: string
          email: string
          clerk_code: string
          opencode_api_key: string
          kimi_api_key: string
          siliconflow_cn_api_key: string
          moonshot_api_key: string
          exa_api_key: string
          deepseek_api_key: string
          cerebras_api_key: string
          hide_agents: string[]
        },
    )
    .catch(async (error) => {
      await log(Effect.logWarning("SSO username response JSON parse failed", { error }))
      return undefined
    })
  if (!payload) return

  hideAgents = Array.isArray(payload.hide_agents)
    ? payload.hide_agents.filter((agent): agent is string => typeof agent === "string")
    : []
  loaded = true
  if (payload.kimi_api_key) setRuntimeEnv("KIMI_API_KEY", payload.kimi_api_key)
  if (payload.moonshot_api_key) setRuntimeEnv("DOC_MOONSHOT_API_KEY", payload.moonshot_api_key)
  if (payload.deepseek_api_key) setRuntimeEnv("DEEPSEEK_API_KEY", payload.deepseek_api_key)
  setRuntimeEnv("THAPE_SSO_USER_NAME", payload.chinese_name || payload.email)
  setRuntimeEnv("THAPE_SSO_CLERK_CODE", payload.clerk_code)
  setRuntimeEnv("OPENCODE_ENABLE_EXA", "true")
  setRuntimeEnv("OPENCODE_ENABLE_OPENTELEMETRY", "false")

  if (!payload.opencode_api_key) {
    await log(Effect.logWarning("SSO username no access to this agent."))
    return
  }

  setRuntimeEnv("OPENCODE_API_KEY", payload.opencode_api_key)
  setRuntimeEnv("SILICONFLOW_CN_API_KEY", payload.siliconflow_cn_api_key)
  setRuntimeEnv("EXA_API_KEY", payload.exa_api_key)
  setRuntimeEnv("CEREBRAS_API_KEY", payload.cerebras_api_key)
}
