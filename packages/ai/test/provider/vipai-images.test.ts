import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/http"
import { ai, ImageClient, Media } from "../../src/effect.js"
import { model } from "../../src/providers/vipai/images.js"
import { Google } from "../../src/providers.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"

const source = Media.base64("aW1hZ2U=", "image/png")
const painter = (id = "gpt-image-2") => model(id, { apiKey: "test-key", baseURL: "https://vipai.test/v1" })
const response = { headers: { "content-type": "application/json" } }

// These cases replace thape-config/script/image.test.ts at the provider boundary.
describe("VIPAI Images", () => {
  it.effect("sends GPT defaults and returns every variation", () =>
    ai.image.generate({ model: painter(), prompt: "courtyard", n: 10 }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result.images).toHaveLength(10))),
      Effect.provide(
        ImageClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) => {
              expect(input.request.url).toBe("https://vipai.test/v1/images/generations")
              expect(input.request.headers.authorization).toBe("Bearer test-key")
              expect(JSON.parse(input.text)).toEqual({
                model: "gpt-image-2",
                prompt: "courtyard",
                n: 10,
                size: "1024x1024",
                quality: "standard",
                style: "vivid",
                response_format: "url",
              })
              return Effect.succeed(
                input.respond(
                  JSON.stringify({ data: Array.from({ length: 10 }, () => ({ b64_json: "aW1hZ2U=" })) }),
                  response,
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("uploads ordered Gemini sources, references and mask with native resolution", () =>
    ai.image
      .generate({
        model: painter("gemini-3-pro-image-preview"),
        prompt: "preserve geometry",
        images: [source, source, source],
        aspect: "3:2",
        resolution: "4K",
        providerOptions: { mask: source, style: "cinematic" },
      })
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.images).toHaveLength(1))),
        Effect.provide(
          ImageClient.layer.pipe(
            Layer.provide(
              dynamicResponse((input) =>
                Effect.gen(function* () {
                  const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                  const form = yield* Effect.promise(() => web.formData())
                  expect(web.url).toEndWith("/images/edits")
                  expect([...form.keys()].filter((key) => form.get(key) instanceof File)).toEqual([
                    "image",
                    "image1",
                    "image2",
                    "mask",
                  ])
                  expect(form.get("aspect_ratio")).toBe("3:2")
                  expect(form.get("image_size")).toBe("4K")
                  expect(form.get("style")).toBe("cinematic")
                  expect(form.has("quality")).toBe(false)
                  return input.respond(
                    JSON.stringify({
                      data: [{ url: "https://cdn.test/image.png" }, { url: "https://cdn.test/ignored.png" }],
                    }),
                    response,
                  )
                }),
              ),
            ),
          ),
        ),
      ),
  )

  it.effect("preserves legacy GPT edit size and quality mapping", () =>
    Effect.forEach(
      [
        ["16x9", "2k", "1536x1024", "medium"],
        ["portrait", "hd", "1024x1536", "low"],
        ["1536x1024", "1k", "auto", "low"],
      ],
      ([size, quality, expectedSize, expectedQuality]) =>
        ai.image
          .generate({ model: painter(), prompt: "edit", images: [source], providerOptions: { size, quality } })
          .pipe(
            Effect.provide(
              ImageClient.layer.pipe(
                Layer.provide(
                  dynamicResponse((input) =>
                    Effect.gen(function* () {
                      const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                      const form = yield* Effect.promise(() => web.formData())
                      expect(form.get("size")).toBe(expectedSize)
                      expect(form.get("quality")).toBe(expectedQuality)
                      return input.respond(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), response)
                    }),
                  ),
                ),
              ),
            ),
          ),
    ),
  )

  it.effect("rejects incompatible options before sending HTTP", () =>
    Effect.forEach(
      [
        { model: painter("gemini-3-pro-image-preview"), n: 2 },
        { model: painter("gemini-3-pro-image-preview"), providerOptions: { quality: "medium" } },
        { model: painter(), providerOptions: { mask: source } },
        { model: painter(), images: [source, source] },
        { model: painter(), images: [source], providerOptions: { style: "vivid" } },
        { model: painter(), resolution: "4K" },
      ],
      (input) =>
        ai.image.generate({ ...input, prompt: "invalid" }).pipe(
          Effect.flip,
          Effect.tap((error) => Effect.sync(() => expect(error.message.length).toBeGreaterThan(0))),
          Effect.provide(ImageClient.layer.pipe(Layer.provide(dynamicResponse(() => Effect.die("unexpected HTTP"))))),
        ),
    ),
  )

  it.effect("rejects empty and malformed provider images", () =>
    Effect.forEach(
      [{}, { data: [] }, { data: [{}] }, { data: [{ b64_json: "!!!" }] }, { data: [{ url: "invalid" }] }],
      (body) =>
        ai.image.generate({ model: painter(), prompt: "draw" }).pipe(
          Effect.flip,
          Effect.tap((error) => Effect.sync(() => expect(error.reason._tag).toBe("InvalidProviderOutput"))),
          Effect.provide(ImageClient.layer.pipe(Layer.provide(fixedResponse(JSON.stringify(body), response)))),
        ),
    ),
  )

  it.effect("requires each route's own credential without substituting the other provider's key", () =>
    Effect.forEach(
      [
        {
          selected: model("gpt-image-2"),
          credential: "VIPAI_API_KEY",
          env: { GOOGLE_GENERATIVE_AI_API_KEY: "wrong-provider-key" },
        },
        {
          selected: Google.configure().image("gemini-3-pro-image"),
          credential: "GOOGLE_GENERATIVE_AI_API_KEY",
          env: { VIPAI_API_KEY: "wrong-provider-key" },
        },
      ],
      (entry) =>
        ai.image.generate({ model: entry.selected, prompt: "draw" }).pipe(
          Effect.flip,
          Effect.tap((error) => Effect.sync(() => expect(error.message).toContain(entry.credential))),
          Effect.provide(ImageClient.layer.pipe(Layer.provide(dynamicResponse(() => Effect.die("unexpected HTTP"))))),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: entry.env }))),
        ),
    ),
  )

  it.effect("preserves routing errors without a second provider request", () => {
    const calls: string[] = []
    return ai.image.generate({ model: painter(), prompt: "draw" }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.code).toBe("model_not_found")
          expect(error.status).toBe(503)
          expect(calls).toEqual(["https://vipai.test/v1/images/generations"])
        }),
      ),
      Effect.provide(
        ImageClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) => {
              calls.push(input.request.url)
              return Effect.succeed(
                input.respond(
                  JSON.stringify({
                    error: { code: "model_not_found", message: "No available channel", request_id: "routing-1" },
                  }),
                  { ...response, status: 503 },
                ),
              )
            }),
          ),
        ),
      ),
    )
  })
})

describe("Google image migration", () => {
  it.effect("sends style, ordered images, visual mask and native 4K without a guessed ratio", () =>
    ai.image
      .generate({
        model: Google.configure({ apiKey: "google-key" }).image("gemini-3-pro-image"),
        prompt: "edit",
        images: [source, source],
        resolution: "4K",
        providerOptions: { mask: source, style: "warm" },
      })
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.images).toHaveLength(1))),
        Effect.provide(
          ImageClient.layer.pipe(
            Layer.provide(
              dynamicResponse((input) => {
                const body = JSON.parse(input.text)
                expect(input.request.headers["x-goog-api-key"]).toBe("google-key")
                expect(body.generationConfig).toEqual({
                  responseModalities: ["IMAGE"],
                  imageConfig: { imageSize: "4K" },
                })
                expect(body.contents[0].parts).toHaveLength(5)
                expect(body.contents[0].parts[0].text).toContain("Style: warm")
                expect(body.contents[0].parts[3].text).toBe("Mask (visual guidance):")
                return Effect.succeed(
                  input.respond(
                    JSON.stringify({
                      candidates: [
                        {
                          content: {
                            parts: [
                              { thought: true, inlineData: { mimeType: "image/png", data: "ZHJhZnQ=" } },
                              { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
                            ],
                          },
                        },
                      ],
                    }),
                    response,
                  ),
                )
              }),
            ),
          ),
        ),
      ),
  )

  it.effect("rejects text-only, blocked and thought-only responses", () =>
    Effect.forEach(
      [
        { candidates: [{ content: { parts: [{ text: "No image" }] } }] },
        { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] },
        {
          candidates: [
            { content: { parts: [{ thought: true, inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] } },
          ],
        },
      ],
      (body) =>
        ai.image
          .generate({ model: Google.configure({ apiKey: "test" }).image("gemini-3-pro-image"), prompt: "draw" })
          .pipe(
            Effect.flip,
            Effect.tap((error) => Effect.sync(() => expect(error.message.length).toBeGreaterThan(0))),
            Effect.provide(ImageClient.layer.pipe(Layer.provide(fixedResponse(JSON.stringify(body), response)))),
          ),
    ),
  )
})
