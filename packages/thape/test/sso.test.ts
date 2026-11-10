import { afterEach, beforeEach, expect, test } from "bun:test"
import { KimiEnvironment } from "@opencode/util/kimi-environment"
import { isApiKeyEnvName, ensureSsoUsername, ssoHideAgents } from "../src/sso.js"
import { http } from "./http.js"

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
const original = new Map(keys.map((key) => [key, process.env[key]]))

beforeEach(() => keys.forEach((key) => delete process.env[key]))
afterEach(() => {
  original.forEach((value, key) => {
    if (value === undefined) {
      delete process.env[key]
      return
    }

    process.env[key] = value
  })
})

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

test("populates the runtime environment and caches the SSO identity", async () => {
  process.env.THAPE_SSO_BEARER_API_KEY = "sso-token"

  using server = http((request) => {
    expect(request.method).toBe("OPTIONS")
    expect(request.headers.get("Authorization")).toBe("Bearer sso-token")
    expect(request.headers.get("JWT-AUD")).toBe("opencode")
    expect(request.headers.get("Accept")).toBe("application/json")
    expect(request.headers.get("Content-Type")).toBe("application/json")

    return Response.json({
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
      cerebras_api_key: "cerebras-key",
      vipai_api_key: "vipai-key",
      hide_agents: ["bid-assistant", 42, "7777"],
    })
  })

  await ensureSsoUsername(server.request)
  await ensureSsoUsername(server.request)

  expect(server.urls).toEqual(["https://sso.thape.com.cn/api/me.json"])

  const expected = {
    THAPE_SSO_USER_NAME: "Test User",
    THAPE_SSO_CLERK_CODE: "123456",
    OPENCODE_API_KEY: "opencode-key",
    KIMI_API_KEY: "kimi-key",
    KIMI_API_KEY_2: "kimi-key-2",
    KIMI_API_KEY_3: "kimi-key-3",
    KIMI_API_KEY_4: "kimi-key-4",
    DOC_MOONSHOT_API_KEY: "moonshot-key",
    SILICONFLOW_CN_API_KEY: "siliconflow-key",
    EXA_API_KEY: "exa-key",
    CEREBRAS_API_KEY: "cerebras-key",
    VIPAI_API_KEY: "vipai-key",
    OPENCODE_ENABLE_EXA: "true",
    OPENCODE_ENABLE_OPENTELEMETRY: "false",
  }

  expect(process.env).toMatchObject(expected)
  expect(Bun.env).toMatchObject(expected)
  expect(process.env.DEEPSEEK_API_KEY).toBeUndefined()
  expect(process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBeUndefined()
  expect(ssoHideAgents()).toEqual(["bid-assistant", "7777"])
  ssoHideAgents().push("unrelated")
  expect(ssoHideAgents()).toEqual(["bid-assistant", "7777"])
})

test("clears stale Kimi slots and ignores invalid entries", async () => {
  process.env.THAPE_SSO_BEARER_API_KEY = "sso-token"
  process.env.KIMI_API_KEY = "old-primary"
  process.env.KIMI_API_KEY_2 = "old-secondary"
  process.env.KIMI_API_KEY_4 = "old-fourth"
  process.env.KIMI_API_KEY_12 = "old-twelfth"

  using server = http(() => Response.json({ kimi_api_keys: [null, "", " ", 42, "new-key"] }))

  await ensureSsoUsername(server.request)

  expect(process.env.KIMI_API_KEY).toBe("new-key")
  expect(Bun.env.KIMI_API_KEY).toBe("new-key")
  ;["KIMI_API_KEY_2", "KIMI_API_KEY_4", "KIMI_API_KEY_12"].forEach((name) => {
    expect(process.env[name]).toBeUndefined()
    expect(Bun.env[name]).toBeUndefined()
  })
})

test.each([[], null, undefined, "not-an-array"].map((kimi_api_keys) => ({ kimi_api_keys })))(
  "ignores legacy keys when kimi_api_keys is %j",
  async (payload) => {
    process.env.THAPE_SSO_BEARER_API_KEY = "sso-token"
    process.env.KIMI_API_KEY = "old-primary"
    process.env.KIMI_API_KEY_4 = "old-fourth"

    using server = http(() => Response.json({ ...payload, kimi_api_key_1: "legacy-1", kimi_api_key_2: "legacy-2" }))

    await ensureSsoUsername(server.request)

    expect(process.env.KIMI_API_KEY).toBeUndefined()
    expect(process.env.KIMI_API_KEY_2).toBeUndefined()
    expect(process.env.KIMI_API_KEY_4).toBeUndefined()
  },
)

test("clears an unauthorized bearer key and hidden agents", async () => {
  process.env.THAPE_SSO_BEARER_API_KEY = "expired-token"

  using server = http(() => new Response(undefined, { status: 401 }))

  await ensureSsoUsername(server.request)

  expect(process.env.THAPE_SSO_BEARER_API_KEY).toBeUndefined()
  expect(Bun.env.THAPE_SSO_BEARER_API_KEY).toBeUndefined()
  expect(ssoHideAgents()).toEqual([])
})

test("does not request SSO without a bearer token", async () => {
  using server = http(() => Response.json({}))

  await ensureSsoUsername(server.request)

  expect(server.urls).toEqual([])
})

test.each(["status", "json", "network"])("allows a retry after a %s failure", async (failure) => {
  process.env.THAPE_SSO_BEARER_API_KEY = "sso-token"

  using server = http(() =>
    failure === "status" ? new Response("unavailable", { status: 503 }) : new Response("invalid JSON"),
  )

  await ensureSsoUsername(failure === "network" ? () => Promise.reject(new Error("offline")) : server.request)

  expect(process.env.THAPE_SSO_BEARER_API_KEY).toBe("sso-token")
  expect(process.env.OPENCODE_API_KEY).toBeUndefined()

  using retry = http(() => Response.json({ email: "test@example.com", opencode_api_key: "retry-key" }))

  await ensureSsoUsername(retry.request)

  expect(process.env.OPENCODE_API_KEY).toBe("retry-key")
  expect(process.env.THAPE_SSO_USER_NAME).toBe("test@example.com")
})
