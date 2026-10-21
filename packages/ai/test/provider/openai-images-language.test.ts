import { expect } from "bun:test"
import { Effect, Stream } from "effect"
import { HttpClientRequest } from "effect/http"
import { LLM, LLMEvent, Media, Message } from "../../src/index.js"
import { model } from "../../src/providers/openai/images.js"
import { testEffect } from "../lib/effect.js"
import { dynamicResponse, json } from "../lib/http.js"

const image = model("gpt-image-2", {
  baseURL: "https://images.test/v1",
  apiKey: "fixture",
  provider: "vipai",
  headers: { "x-provider": "yes" },
  body: { size: "1024x1024", n: 1 },
})

for (const output of [{ url: "https://images.test/result.png" }, { b64_json: "AQID" }]) {
  testEffect(
    dynamicResponse((input) => {
      expect(input.request.url).toBe("https://images.test/v1/images/generations")
      expect(input.request.headers.authorization).toBe("Bearer fixture")
      expect(input.request.headers["x-provider"]).toBe("yes")
      expect(input.request.headers["x-request"]).toBe("yes")
      expect(JSON.parse(input.text)).toEqual({
        model: "gpt-image-2",
        prompt: "A koi pond",
        size: "1024x1024",
        n: 1,
        quality: "high",
      })

      return Effect.succeed(
        json(input, { data: [output], usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 } }),
      )
    }),
  ).effect(`generates session image output from ${"url" in output ? "URL" : "base64"} responses`, () =>
    Effect.gen(function* () {
      const events = yield* LLM.stream({
        model: image,
        system: "Agent instructions must not become the image prompt",
        messages: [Message.user("Earlier request"), Message.assistant("Earlier reply"), Message.user("A koi pond")],
        generation: { maxTokens: 100, temperature: 0.2 },
        providerOptions: { quality: "high" },
        http: { headers: { "x-request": "yes" } },
      }).pipe(Stream.runCollect)

      expect(events.map((event) => event.type)).toEqual(["media", "step-finish", "finish"])
      const media = events.find(LLMEvent.is.media)?.media
      expect(media?.mediaType).toBe("image/png")
      expect(media?.source).toMatchObject(
        "url" in output
          ? { type: "url", url: output.url }
          : { type: "bytes", data: Uint8Array.from([1, 2, 3]), mediaType: "image/png" },
      )
      expect(events.find(LLMEvent.is.stepFinish)?.usage).toMatchObject({ inputTokens: 4, outputTokens: 8, totalTokens: 12 })
      expect(events.find(LLMEvent.is.finish)?.reason.normalized).toBe("stop")
    }),
  )
}

testEffect(
  dynamicResponse((input) =>
    Effect.gen(function* () {
      const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
      expect(request.url).toBe("https://images.test/v1/images/edits")
      const form = yield* Effect.promise(() => request.formData())
      expect(form.get("prompt")).toBe("Make it blue")
      expect(form.get("model")).toBe("gpt-image-2")
      expect(form.get("image[]")).toBeInstanceOf(Blob)
      expect(form.get("size")).toBe("1024x1024")

      return json(input, { data: [{ url: "https://images.test/edited.png" }] })
    }),
  ),
).effect("passes explicit image attachments through the Images edit protocol", () =>
  Effect.gen(function* () {
    const response = yield* LLM.generate({
      model: image,
      prompt: [Message.text("Make it blue"), Message.media(Media.bytes(Uint8Array.from([1, 2, 3]), "image/png"))],
    })

    expect(response.events.find(LLMEvent.is.media)?.media.source).toMatchObject({
      type: "url",
      url: "https://images.test/edited.png",
    })
  }),
)
