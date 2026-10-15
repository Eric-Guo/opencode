import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, Media, Message } from "../../src/index.js"
import { configure } from "../../src/providers/openrouter.js"
import { LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = configure({ apiKey: "test-key" }).model("google/gemini-nano-banana-2.1")

describe("OpenRouter generated images", () => {
  it.effect("emits image-only output with its MIME type and step lifecycle", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Draw a dinosaur." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              choices: [
                {
                  delta: { images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] },
                  finish_reason: "stop",
                },
              ],
            }),
          ),
        ),
      )

      expect(response.text).toBe("")
      expect(response.message.content).toEqual([{ type: "media", media: Media.base64("aW1hZ2U=", "image/png") }])
      expect(response.events.map((event) => event.type)).toEqual(["step-start", "media", "step-finish", "finish"])
      expect(response.finishReason.normalized).toBe("stop")

      const prepared = yield* compileRequest(
        LLM.request({ model, messages: [response.message, Message.user("Make it blue.")] }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "assistant", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] },
        { role: "user", content: "Make it blue." },
      ])
    }),
  )

  it.effect("keeps signature-only reasoning before an image when there is no visible text", () =>
    Effect.gen(function* () {
      const details = [{ type: "reasoning.text", format: "google-gemini-v1", index: 0, signature: "image-signature" }]
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Draw a dinosaur." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { choices: [{ delta: { reasoning_details: details } }] },
              {
                choices: [
                  {
                    delta: { images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] },
                    finish_reason: "stop",
                  },
                ],
              },
            ),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        { type: "reasoning", text: "", providerMetadata: { openrouter: { reasoningDetails: details } } },
        { type: "media", media: Media.base64("aW1hZ2U=", "image/png") },
      ])
      expect(response.events.map((event) => event.type)).toEqual([
        "step-start",
        "reasoning-start",
        "media",
        "reasoning-end",
        "step-finish",
        "finish",
      ])
    }),
  )

  it.effect("retains text, multiple images, and Gemini reasoning signatures on replay", () =>
    Effect.gen(function* () {
      const details = [{ type: "reasoning.text", format: "google-gemini-v1", index: 0, signature: "image-signature" }]
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Draw two dinosaurs." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { choices: [{ delta: { reasoning_details: details } }] },
              { choices: [{ delta: { content: "Here are your dinosaurs." } }] },
              {
                choices: [
                  {
                    delta: {
                      images: [
                        { type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
                        { type: "image_url", image_url: { url: "data:image/jpeg;base64,anBlZw==" } },
                      ],
                    },
                    finish_reason: "stop",
                  },
                ],
              },
              { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
            ),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        { type: "reasoning", text: "", providerMetadata: { openrouter: { reasoningDetails: details } } },
        { type: "text", text: "Here are your dinosaurs." },
        { type: "media", media: Media.base64("cG5n", "image/png") },
        { type: "media", media: Media.base64("anBlZw==", "image/jpeg") },
      ])
      expect(response.events.filter(LLMEvent.is.media)).toHaveLength(2)
      expect(response.usage.totalTokens).toBe(30)

      const prepared = yield* compileRequest(
        LLM.request({ model, messages: [response.message, Message.user("Put them in Qing dynasty clothing.")] }),
      )

      expect(prepared.body.messages[0]).toEqual({
        role: "assistant",
        content: [
          { type: "text", text: "Here are your dinosaurs." },
          { type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,anBlZw==" } },
        ],
        reasoning_details: details,
      })
    }),
  )

  it.effect("retains image URLs without treating them as base64", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Draw a dinosaur." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              choices: [
                {
                  delta: { images: [{ type: "image_url", image_url: { url: "https://example.com/dinosaur.jpg" } }] },
                  finish_reason: "stop",
                },
              ],
            }),
          ),
        ),
      )

      expect(response.message.content).toEqual([
        { type: "media", media: Media.url("https://example.com/dinosaur.jpg", { mediaType: "image/jpeg" }) },
      ])

      const prepared = yield* compileRequest(LLM.request({ model, messages: [response.message] }))

      expect(prepared.body.messages[0]).toEqual({
        role: "assistant",
        content: [{ type: "image_url", image_url: { url: "https://example.com/dinosaur.jpg" } }],
      })
    }),
  )

  it.effect("rejects images received after the finish reason", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Draw a dinosaur." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { choices: [{ delta: {}, finish_reason: "stop" }] },
              {
                choices: [
                  { delta: { images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] } },
                ],
              },
            ),
          ),
        ),
        Effect.flip,
      )

      expect(error.message).toContain("OpenAI Chat received content after the finish reason")
    }),
  )

  it.effect("rejects non-image assistant media", () =>
    Effect.gen(function* () {
      const error = yield* compileRequest(
        LLM.request({
          model,
          messages: [Message.assistant([{ type: "media", media: Media.base64("YXVkaW8=", "audio/mpeg") }])],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("OpenAI Chat assistant does not support media type audio/mpeg")
    }),
  )
})
