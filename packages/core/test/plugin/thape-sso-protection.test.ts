import { describe, expect, test } from "bun:test"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ThapeSsoProtection, REDACTED, redact } from "@opencode/core/plugin/thape-sso-protection"
import { Provider } from "@opencode/core/provider"
import { Document, Info } from "@opencode/schema/config"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("ThapeSsoProtection", () => {
  for (const scenario of [
    { name: "missing OpenCode access", key: undefined, disabled: false, allowed: false },
    { name: "empty OpenCode key", key: "", disabled: false, allowed: false },
    { name: "blank OpenCode key", key: "  ", disabled: false, allowed: false },
    { name: "OpenCode access", key: "opencode-key", disabled: false, allowed: true },
    { name: "an explicitly disabled model", key: "opencode-key", disabled: true, allowed: true },
  ]) {
    it.effect(`gates configured VIPAI GPT models with ${scenario.name}`, () =>
      withEnv({ OPENCODE_API_KEY: scenario.key, VIPAI_API_KEY: "vipai-key" }, () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const host = yield* PluginHost.make(plugin)
          const models = yield* Model.Service

          yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
            Effect.provide(
              Config.testLayer([
                new Document({
                  type: "document",
                  info: Schema.decodeUnknownSync(Info)({
                    providers: {
                      vipai: {
                        package: "@opencode/ai/providers/openai-compatible",
                        settings: { baseURL: "https://new.vipai.me/v1", apiKey: "vipai-key" },
                        models: {
                          "gpt-6-astra": { disabled: scenario.disabled },
                          "gpt-6.1-sol": { disabled: false },
                          "gpt-image-2": {},
                          "gemini-3.1-flash-image": {},
                        },
                      },
                      other: {
                        package: "@opencode/ai/providers/openai-compatible",
                        models: { "gpt-6-astra": {}, "gpt-6.1-sol": {} },
                      },
                    },
                  }),
                }),
              ]),
            ),
          )
          yield* ThapeSsoProtection.Plugin.effect(host)

          const available = (yield* models.available()).map((model) => `${model.providerID}/${model.id}`)

          expect(available.includes("vipai/gpt-6-astra")).toBe(scenario.allowed && !scenario.disabled)
          expect(available.includes("vipai/gpt-6.1-sol")).toBe(scenario.allowed)
          expect(available).toContain("vipai/gpt-image-2")
          expect(available).toContain("vipai/gemini-3.1-flash-image")
          expect(available).toContain("other/gpt-6-astra")
          expect(available).toContain("other/gpt-6.1-sol")

          const model = yield* models.get(Provider.ID.make("vipai"), Model.ID.make("gpt-6.1-sol"))

          if (!scenario.allowed) {
            expect(model).toBeUndefined()
            return
          }

          expect(model?.settings).toMatchObject({ baseURL: "https://new.vipai.me/v1", apiKey: "vipai-key" })
        }),
      ),
    )
  }

  test("redacts API keys from nested tool results", () => {
    expect(
      redact(
        {
          text: "token=opencode-secret",
          nested: ["opencode-secret", { url: "https://example.test/opencode-secret" }],
          unchanged: 1,
        },
        ["opencode-secret"],
      ),
    ).toEqual({
      text: `token=${REDACTED}`,
      nested: [REDACTED, { url: `https://example.test/${REDACTED}` }],
      unchanged: 1,
    })
  })

  test("preserves Tool.Error behavior while redacting", () => {
    const error = redact(
      new Tool.Error({
        message: "token=opencode-secret",
        metadata: { nested: ["opencode-secret"] },
      }),
      ["opencode-secret"],
    )

    expect(error).toBeInstanceOf(Tool.Error)
    expect(error.message).toBe(`token=${REDACTED}`)
    expect(error.metadata).toEqual({ nested: [REDACTED] })
  })
})
