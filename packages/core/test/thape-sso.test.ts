import { afterEach, expect, test } from "bun:test"
import { API_KEY_ENV_NAMES, ensureSsoUsername, ssoHideAgents } from "../src/thape-sso"

const keys = [
  "THAPE_SSO_BEARER_API_KEY",
  "THAPE_SSO_USER_NAME",
  "THAPE_SSO_CLERK_CODE",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "DOC_MOONSHOT_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_ENABLE_OPENTELEMETRY",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "SILICONFLOW_CN_API_KEY",
  "EXA_API_KEY",
  "CEREBRAS_API_KEY",
]

const originalEnv = new Map(keys.map((key) => [key, process.env[key]]))
const originalBunEnv = new Map(keys.map((key) => [key, Bun.env[key]]))
const originalFetch = globalThis.fetch

test("keeps the bearer key available to tools", () => {
  expect(API_KEY_ENV_NAMES).not.toContain("THAPE_SSO_BEARER_API_KEY")
  expect(API_KEY_ENV_NAMES).toContain("OPENCODE_API_KEY")
})

afterEach(() => {
  for (const key of keys) {
    const env = originalEnv.get(key)
    const bunEnv = originalBunEnv.get(key)
    if (env === undefined) delete process.env[key]
    else process.env[key] = env
    if (bunEnv === undefined) delete Bun.env[key]
    else Bun.env[key] = bunEnv
  }
  globalThis.fetch = originalFetch
})

test("ensureSsoUsername populates the runtime environment", async () => {
  for (const key of keys) {
    delete process.env[key]
    delete Bun.env[key]
  }
  process.env.THAPE_SSO_BEARER_API_KEY = "sso-token"
  Bun.env.THAPE_SSO_BEARER_API_KEY = "sso-token"

  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        chinese_name: "Test User",
        email: "test@example.com",
        clerk_code: "123456",
        opencode_api_key: "opencode-key",
        kimi_api_key: "kimi-key",
        siliconflow_cn_api_key: "siliconflow-key",
        moonshot_api_key: "moonshot-key",
        exa_api_key: "exa-key",
        deepseek_api_key: "deepseek-key",
        cerebras_api_key: "cerebras-key",
        hide_agents: ["bid-assistant", "7777"],
      }),
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch

  await ensureSsoUsername()

  expect(process.env.THAPE_SSO_USER_NAME).toBe("Test User")
  expect(process.env.OPENCODE_API_KEY).toBe("opencode-key")
  expect(ssoHideAgents()).toEqual(["bid-assistant", "7777"])
  expect(process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBeUndefined()
  expect(Bun.env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBeUndefined()
})
