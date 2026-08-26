import { describe, expect, test } from "bun:test"
import { isContextOverflow } from "../src/index.js"
import { classifyProviderFailure } from "../src/provider-error.js"

describe("provider error classification", () => {
  test("classifies provider token limit messages as context overflow", () => {
    const messages = [
      "tokens in request more than max tokens allowed",
      "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      "Input length (265330) exceeds model's maximum context length (262144).",
      "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
      "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
      "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
      "Too many tokens",
      "Token limit exceeded",
    ]

    expect(messages.every(isContextOverflow)).toBe(true)
  })

  test("classifies Anthropic request_too_large as recoverable overflow", () => {
    expect(
      classifyProviderFailure({
        message: '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
        status: 400,
      }),
    ).toMatchObject({ _tag: "InvalidRequest", classification: "context-overflow" })
    expect(isContextOverflow("413 status code (no body)")).toBe(true)
  })

  test("classifies generic request size failures separately from context overflow", () => {
    const failures = [
      classifyProviderFailure({ message: "request too large", status: 413 }),
      classifyProviderFailure({ message: "upstream request entity too large", status: 502 }),
    ]

    expect(failures).toEqual(
      failures.map((failure) =>
        expect.objectContaining({ _tag: "InvalidRequest", classification: "payload-too-large" }),
      ),
    )
  })

  test("does not classify rate limits as context overflow", () => {
    const messages = [
      "Throttling error: Too many tokens, please wait before trying again.",
      "Rate limit exceeded, please retry after 30 seconds.",
      "Too many requests. Please slow down.",
    ]

    expect(messages.some(isContextOverflow)).toBe(false)
  })

  test("classifies V1 plain-text rate limit fallbacks", () => {
    expect(
      [
        "Request rate increased too quickly",
        "Rate limit exceeded, please try again later",
        "Too many requests, please slow down",
      ].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["RateLimit", "RateLimit", "RateLimit"])
  })

  test("classifies V1 JSON rate limit fallbacks", () => {
    expect(
      [
        '{"type":"error","error":{"type":"too_many_requests"}}',
        '{"type":"error","error":{"code":"rate_limit_exceeded"}}',
        '{"code":"bad_request","error":{"code":"rate_limit_exceeded"}}',
        '{"type":"error","error":{"code":"unknown","type":"too_many_requests"}}',
      ].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["RateLimit", "RateLimit", "RateLimit", "RateLimit"])
  })

  test("classifies V1 overloaded provider codes", () => {
    expect(
      ['{"code":"resource_exhausted"}', '{"code":"service_unavailable"}', '{"code":"slow_down"}'].map(
        (message) => classifyProviderFailure({ message })._tag,
      ),
    ).toEqual(["ProviderInternal", "ProviderInternal", "ProviderInternal"])
  })

  test("classifies transient client statuses as provider internal", () => {
    expect([408, 409].map((status) => classifyProviderFailure({ message: `HTTP ${status}`, status })._tag)).toEqual([
      "ProviderInternal",
      "ProviderInternal",
    ])
  })

  test("classifies network error text as provider internal", () => {
    expect(
      ["network error", "network-error", "network_error"].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["ProviderInternal", "ProviderInternal", "ProviderInternal"])
  })

  test("classifies nested provider codes when a top-level code is also present", () => {
    expect(
      [
        '{"code":"bad_request","error":{"code":"usage_not_included"}}',
        '{"code":"bad_request","error":{"code":"server_error"}}',
        '{"code":"bad_request","error":{"type":"invalid_request_error"}}',
      ].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["QuotaExceeded", "ProviderInternal", "InvalidRequest"])
  })

  test("classifies only Kimi's five-hour response as a rolling-window quota", () => {
    expect(
      classifyProviderFailure({
        message: "You've reached your usage limit for this period. Your quota will be refreshed in the next period.",
        status: 429,
      }),
    ).toMatchObject({ _tag: "QuotaExceeded", classification: "rolling-window" })

    expect(
      classifyProviderFailure({
        message:
          "You've reached your usage limit for this period. Your quota will be refreshed in the next period. Contact support.",
        status: 429,
      }),
    ).not.toHaveProperty("classification", "rolling-window")

    const ordinary = [
      ["You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.", 403],
      ["You've reached kimi monthly usage limit for this billing cycle.", 429],
      ["The engine is currently overloaded, please try again later", 429],
      ["We're receiving too many requests at the moment. Please wait a moment and try again.", 429],
      ["The API Key appears to be invalid or may have expired.", 401],
      ["Your current subscription does not have access to kimi-for-coding-highspeed.", 401],
      ["Access terminated.", 403],
    ] as const

    expect(
      ordinary.map(([message, status]) => {
        const reason = classifyProviderFailure({ message, status })
        return "classification" in reason ? reason.classification : undefined
      }),
    ).toEqual(ordinary.map(() => undefined))
  })

  test("keeps unknown and malformed provider payloads non-retryable", () => {
    expect(classifyProviderFailure({ message: '{"error":{"message":"no_kv_space"}}' })._tag).toBe("UnknownProvider")
    expect(classifyProviderFailure({ message: '{"type":"error","error":{"code":123}}' })._tag).toBe("UnknownProvider")
    expect(classifyProviderFailure({ message: "not-json" })._tag).toBe("UnknownProvider")
  })
})

describe("provider error rawBody classification", () => {
  test("classifies overflow signals buried in the raw payload when the summary is vague", () => {
    const reason = classifyProviderFailure({
      message: "Request failed",
      rawBody: '{"error":{"message":"This model\'s maximum context length is 40960 tokens"}}',
    })
    expect(reason._tag).toBe("InvalidRequest")
    expect(reason).toMatchObject({ classification: "context-overflow" })
  })

  test("extracts nested codes from the raw payload", () => {
    expect(
      classifyProviderFailure({ message: "Request failed", rawBody: '{"error":{"code":"insufficient_quota"}}' })._tag,
    ).toBe("QuotaExceeded")
  })
})
