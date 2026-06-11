import { Observability } from "@opencode-ai/core/observability"
import { Effect, ManagedRuntime } from "effect"

const SSO_ME_URL = "https://sso.thape.com.cn/api/me.json"
const runtime = ManagedRuntime.make(Observability.layer)
const bun = globalThis as typeof globalThis & { Bun?: { env: Record<string, string | undefined> } }

function runtimeEnv(key: string) {
  return bun.Bun?.env[key] ?? process.env[key]
}

function log(effect: Effect.Effect<void>) {
  return runtime.runPromise(effect.pipe(Effect.annotateLogs({ service: "util.thape_sso" })))
}

function setRuntimeEnv(key: string, value: string) {
  if (bun.Bun) {
    bun.Bun.env[key] = value
  }
  process.env[key] = value
}

function hasValue(value: string | undefined) {
  return typeof value === "string" && value.trim().length > 0
}

export async function ensureSsoUsername() {
  if (hasValue(runtimeEnv("THAPE_SSO_USER_NAME")) && hasValue(runtimeEnv("OPENCODE_API_KEY"))) return

  const token = runtimeEnv("THAPE_SSO_BEARER_API_KEY")
  if (!token) {
    await log(Effect.logDebug("skipping SSO username lookup; THAPE_SSO_BEARER_API_KEY not set"))
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  let response: Response
  try {
    response = await fetch(SSO_ME_URL, {
      method: "OPTIONS",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "JWT-AUD": "opencode",
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
  } catch (error) {
    await log(Effect.logWarning("SSO username request failed", { error }))
    return
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    await log(
      Effect.logWarning("SSO username request returned non-OK status", {
        status: response.status,
        statusText: response.statusText,
      }),
    )
    return
  }

  let payload:
    | {
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
      }
    | undefined
  try {
    payload = (await response.json()) as {
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
    }
  } catch (error) {
    await log(Effect.logWarning("SSO username response JSON parse failed", { error }))
    return
  }

  const username = payload.chinese_name || payload.email

  const opencode_api_key = payload.opencode_api_key
  const kimi_api_key = payload.kimi_api_key
  const moonshot_api_key = payload.moonshot_api_key
  const deepseek_api_key = payload.deepseek_api_key

  if (kimi_api_key) {
    setRuntimeEnv("KIMI_API_KEY", kimi_api_key)
  }
  if (moonshot_api_key) {
    setRuntimeEnv("DOC_MOONSHOT_API_KEY", moonshot_api_key)
  }
  if (deepseek_api_key) {
    setRuntimeEnv("DEEPSEEK_API_KEY", deepseek_api_key)
  }
  setRuntimeEnv("THAPE_SSO_USER_NAME", username)
  setRuntimeEnv("THAPE_SSO_CLERK_CODE", payload.clerk_code)
  setRuntimeEnv("OPENCODE_ENABLE_EXA", "true")
  setRuntimeEnv("OPENCODE_ENABLE_OPENTELEMETRY", "false")

  if (!opencode_api_key) {
    await log(Effect.logWarning("SSO username no access to this agent."))
    return
  }

  setRuntimeEnv("OPENCODE_API_KEY", opencode_api_key)
  setRuntimeEnv("SILICONFLOW_CN_API_KEY", payload.siliconflow_cn_api_key)
  setRuntimeEnv("EXA_API_KEY", payload.exa_api_key)
  setRuntimeEnv("CEREBRAS_API_KEY", payload.cerebras_api_key)
}
