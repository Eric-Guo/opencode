import { describe, expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { ThapeSsoProtection } from "@opencode/thape/sso-protection"
import { Provider } from "@opencode/core/provider"
import { Document, Info } from "@opencode/schema/config"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema } from "effect"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.effect("registers read protection and redaction with the real plugin host", () =>
  withEnv({ OPENCODE_API_KEY: "secret-key", THAPE_SSO_BEARER_API_KEY: "bearer-token" }, () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const hooks = yield* PluginHooks.Service
      const host = yield* PluginHost.make(plugin, ThapeSsoProtection.ID)
      const call = {
        tool: "read",
        sessionID: Session.ID.make("ses_protection"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_protection"),
        id: Tool.CallID.make("call_protection"),
      }

      yield* ThapeSsoProtection.Plugin.effect(host)

      const blocked = yield* hooks
        .trigger("tool", "execute.before", { ...call, input: { path: ".env.local" } })
        .pipe(Effect.exit)

      expect(Exit.isFailure(blocked)).toBe(true)
      yield* hooks.trigger("tool", "execute.before", { ...call, input: { path: "README.md" } })

      const completed = yield* hooks.trigger("tool", "execute.after", {
        ...call,
        input: {},
        status: "completed",
        result: {
          output: { key: "secret-key" },
          content: [{ type: "text", text: "secret-key bearer-token" }],
          metadata: { nested: ["secret-key"] },
        },
      })
      const failed = yield* hooks.trigger("tool", "execute.after", {
        ...call,
        input: {},
        status: "error",
        error: new Tool.Error({ message: "secret-key", metadata: { key: "secret-key" } }),
      })

      expect(completed).toMatchObject({
        result: {
          output: { key: "[REDACTED]" },
          content: [{ type: "text", text: "[REDACTED] bearer-token" }],
          metadata: { nested: ["[REDACTED]"] },
        },
      })
      expect(failed).toMatchObject({ error: { message: "[REDACTED]", metadata: { key: "[REDACTED]" } } })
    }),
  ),
)

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
          const host = yield* PluginHost.make(plugin, "test")
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
})
