import { afterEach, beforeEach, expect, test } from "bun:test"
import { KimiEnvironment } from "../src/integration/kimi-environment"
import { isApiKeyEnvName, ensureSsoUsername, ssoHideAgents } from "../src/thape-sso"

const keys = [
  "THAPE_SSO_BEARER_API_KEY",
  "THAPE_SSO_USER_NAME",
  "THAPE_SSO_CLERK_CODE",
  "OPENCODE_API_KEY",
  ...new Set([...KimiEnvironment.names(), ...Array.from({ length: 12 }, (_, index) => KimiEnvironment.name(index))]),
  "DOC_MOONSHOT_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_ENABLE_OPENTELEMETRY",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "SILICONFLOW_CN_API_KEY",
  "EXA_API_KEY",
  "CEREBRAS_API_KEY",
  "VIPAI_API_KEY",
]

const originalEnv = new Map(keys.map((key) => [key, process.env[key]]))
const originalBunEnv = new Map(keys.map((key) => [key, Bun.env[key]]))
const originalFetch = globalThis.fetch

test("keeps the bearer key available to tools", () => {
  expect(isApiKeyEnvName("THAPE_SSO_BEARER_API_KEY")).toBe(false)
  expect(isApiKeyEnvName("OPENCODE_API_KEY")).toBe(true)
  expect(isApiKeyEnvName("KIMI_API_KEY")).toBe(true)
  expect(isApiKeyEnvName("KIMI_API_KEY_2")).toBe(true)
  expect(isApiKeyEnvName("KIMI_API_KEY_12")).toBe(true)
  expect(isApiKeyEnvName("KIMI_API_KEY_123")).toBe(true)
  expect(isApiKeyEnvName("KIMI_API_KEY_BACKUP")).toBe(false)
  expect(isApiKeyEnvName("VIPAI_API_KEY")).toBe(true)
})

beforeEach(() => {
  for (const key of keys) {
    delete process.env[key]
    delete Bun.env[key]
  }
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
  process.env.THAPE_SSO_BEARER_API_KEY = "sso-token"
  Bun.env.THAPE_SSO_BEARER_API_KEY = "sso-token"

  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        chinese_name: "Test User",
        email: "test@example.com",
        clerk_code: "123456",
        opencode_api_key: "opencode-key",
        kimi_api_keys: ["kimi-key", "kimi-key-2", "kimi-key-3", "kimi-key-4"],
        kimi_api_key_1: "legacy-key-1",
        kimi_api_key_2: "legacy-key-2",
        siliconflow_cn_api_key: "siliconflow-key",
        moonshot_api_key: "moonshot-key",
        exa_api_key: "exa-key",
        deepseek_api_key: "deepseek-key",
        cerebras_api_key: "cerebras-key",
        vipai_api_key: "vipai-key",
        hide_agents: ["bid-assistant", "7777"],
      }),
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch

  await ensureSsoUsername()

  expect(process.env.THAPE_SSO_USER_NAME).toBe("Test User")
  expect(process.env.THAPE_SSO_CLERK_CODE).toBe("123456")
  expect(process.env.OPENCODE_API_KEY).toBe("opencode-key")
  expect(process.env.KIMI_API_KEY).toBe("kimi-key")
  expect(process.env.KIMI_API_KEY_2).toBe("kimi-key-2")
  expect(process.env.KIMI_API_KEY_3).toBe("kimi-key-3")
  expect(process.env.KIMI_API_KEY_4).toBe("kimi-key-4")
  expect(process.env.DEEPSEEK_API_KEY).toBe("deepseek-key")
  expect(process.env.VIPAI_API_KEY).toBe("vipai-key")
  expect(Bun.env.THAPE_SSO_USER_NAME).toBe("Test User")
  expect(Bun.env.THAPE_SSO_CLERK_CODE).toBe("123456")
  expect(Bun.env.OPENCODE_API_KEY).toBe("opencode-key")
  expect(Bun.env.KIMI_API_KEY).toBe("kimi-key")
  expect(Bun.env.KIMI_API_KEY_2).toBe("kimi-key-2")
  expect(Bun.env.KIMI_API_KEY_3).toBe("kimi-key-3")
  expect(Bun.env.KIMI_API_KEY_4).toBe("kimi-key-4")
  expect(Bun.env.DEEPSEEK_API_KEY).toBe("deepseek-key")
  expect(Bun.env.VIPAI_API_KEY).toBe("vipai-key")
  expect(ssoHideAgents()).toEqual(["bid-assistant", "7777"])
  expect(process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBeUndefined()
  expect(Bun.env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBeUndefined()
})

test("ensureSsoUsername clears stale slots and ignores invalid array entries", async () => {
  process.env.THAPE_SSO_BEARER_API_KEY = "sso-token"
  process.env.KIMI_API_KEY = "old-primary"
  process.env.KIMI_API_KEY_2 = "old-secondary"
  process.env.KIMI_API_KEY_4 = "old-fourth"
  process.env.KIMI_API_KEY_12 = "old-twelfth"
  globalThis.fetch = Object.assign(async () => Response.json({ kimi_api_keys: [null, "", " ", 42, "new-key"] }), {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch

  await ensureSsoUsername()

  expect(process.env.KIMI_API_KEY).toBe("new-key")
  expect(Bun.env.KIMI_API_KEY).toBe("new-key")
  for (const name of ["KIMI_API_KEY_2", "KIMI_API_KEY_4", "KIMI_API_KEY_12"]) {
    expect(process.env[name]).toBeUndefined()
    expect(Bun.env[name]).toBeUndefined()
  }
})

test.each([[], null, undefined, "not-an-array"].map((kimi_api_keys) => ({ kimi_api_keys })))(
  "ensureSsoUsername ignores legacy keys when kimi_api_keys is %j",
  async (payload) => {
    process.env.THAPE_SSO_BEARER_API_KEY = "sso-token"
    process.env.KIMI_API_KEY = "old-primary"
    process.env.KIMI_API_KEY_4 = "old-fourth"
    globalThis.fetch = Object.assign(
      async () => Response.json({ ...payload, kimi_api_key_1: "legacy-key-1", kimi_api_key_2: "legacy-key-2" }),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    await ensureSsoUsername()

    expect(process.env.KIMI_API_KEY).toBeUndefined()
    expect(process.env.KIMI_API_KEY_2).toBeUndefined()
    expect(process.env.KIMI_API_KEY_4).toBeUndefined()
  },
)

test("ensureSsoUsername clears an unauthorized bearer key", async () => {
  process.env.THAPE_SSO_BEARER_API_KEY = "expired-token"
  Bun.env.THAPE_SSO_BEARER_API_KEY = "expired-token"

  globalThis.fetch = Object.assign(async () => new Response(undefined, { status: 401 }), {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch

  await ensureSsoUsername()

  expect(process.env.THAPE_SSO_BEARER_API_KEY).toBeUndefined()
  expect(Bun.env.THAPE_SSO_BEARER_API_KEY).toBeUndefined()
  expect(ssoHideAgents()).toEqual([])
})
