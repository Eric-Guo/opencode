import { Effect, Schema, Stream } from "effect"
import { ImageRequest, ImageResponse } from "../../image.js"
import { OpenAIImages } from "../../protocols/openai-images.js"
import { ProviderShared } from "../../protocols/shared.js"
import { AuthOptions } from "../../route/auth-options.js"
import { Route } from "../../route/client.js"
import { Endpoint } from "../../route/endpoint.js"
import { Protocol } from "../../route/protocol.js"
import type { HttpMiddleware, Transport } from "../../route/transport/index.js"
import { Finish, MediaEvent, StepFinish, Usage, type LLMEvent } from "../../schema/index.js"
import type { ProviderPackage } from "../../provider-package.js"

export type Settings = ProviderPackage.Settings & {
  readonly apiKey?: string
  readonly provider?: string
}

// Images endpoints return one JSON response, even when the caller consumes LLM.stream.
// Reuse the media route so authentication, multipart edits, timeouts, and decoding have one owner.
const transport = {
  id: "openai-images",
  prepare: (input) => Effect.succeed({ request: input.body, middleware: input.middleware }),
  execute: (prepared, _request, runtime) =>
    Effect.succeed({
      frames: Stream.fromEffect(
        prepared.request.model.route.kind === "queued"
          ? Effect.fail(ProviderShared.invalidRequest("OpenAI Images does not support queued generation"))
          : prepared.request.model.route.generate(prepared.request, (request) =>
              runtime.http.execute(request, prepared.middleware),
            ),
      ),
    }),
} satisfies Transport<
  ImageRequest,
  { readonly request: ImageRequest; readonly middleware?: HttpMiddleware },
  ImageResponse
>

export const model: ProviderPackage.Definition<Settings>["model"] = (modelID, settings) => {
  const { apiKey, baseURL, headers, body, provider, ...providerOptions } = settings
  const auth = AuthOptions.bearer({ apiKey }, "OPENAI_API_KEY")
  const image = OpenAIImages.model({ id: modelID, baseURL, auth })
  const protocol = Protocol.make({
    id: "openai-images",
    body: {
      schema: ImageRequest,
      from: Effect.fn("OpenAIImages.fromMessages")(function* (request) {
        // The Images API takes a prompt and explicit edit sources, not a conversation or agent instructions.
        const content = request.messages.findLast((message) => message.role === "user")?.content ?? []
        const prompt = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n")
        if (!prompt.trim()) return yield* ProviderShared.invalidRequest("Image generation requires a user prompt")

        return new ImageRequest({
          model: image,
          prompt,
          images: content.flatMap((part) => (part.type === "media" ? [part.media] : [])),
          providerOptions: request.providerOptions,
          http: request.http,
        })
      }),
    },
    stream: {
      event: Schema.instanceOf(ImageResponse),
      initial: () => undefined,
      step: (_state, response) => {
        const usage =
          response.usage?.type === "tokens"
            ? Usage.from({
                inputTokens: response.usage.input,
                outputTokens: response.usage.output,
                totalTokens: response.usage.total,
              })
            : undefined
        const finish = { reason: { normalized: "stop" as const }, usage, providerMetadata: response.providerMetadata }
        const events: LLMEvent[] = [
          ...response.images.map((media) => MediaEvent.make({ media })),
          StepFinish.make({ ...finish, index: 0 }),
          Finish.make(finish),
        ]

        return Effect.succeed([undefined, events] as const)
      },
    },
  })

  return Route.make({
    id: "openai-images",
    provider: provider ?? "openai",
    protocol,
    endpoint: Endpoint.path("/images/generations", { baseURL: baseURL ?? "https://api.openai.com/v1" }),
    auth,
    transport,
    defaults: { headers, http: body === undefined ? undefined : { body }, providerOptions },
  }).model({ id: modelID })
}
