import { Effect, Schema } from "effect"
import { ImageModel, ImageResponse, type ImageRequest } from "../image.js"
import { Media } from "../media.js"
import { MediaProtocol } from "../route/media-protocol.js"
import { MediaRoute } from "../route/media.js"
import { MediaInput } from "./utils/media-input.js"
import { OpenAIImages } from "./openai-images.js"
import { ProviderShared } from "./shared.js"

const route = MediaProtocol.identity({ id: "vipai-images", name: "VIPAI Images", provider: "vipai" })
const Options = Schema.Struct({
  size: Schema.optionalKey(Schema.String),
  quality: Schema.optionalKey(Schema.String),
  style: Schema.optionalKey(Schema.String),
  mask: Schema.optionalKey(Media.AssetSchema),
})
type Options = typeof Options.Type
type Request = ImageRequest<ImageModel<Options>>

// VIPAI's multipart image/image1/... convention differs from OpenAI's image[].
const fromRequest = Effect.fn("VIPAIImages.fromRequest")(function* (request: Request) {
  const options = yield* Schema.decodeUnknownEffect(Options)(request.providerOptions ?? {}).pipe(
    Effect.mapError((cause) => ProviderShared.invalidRequest("Invalid VIPAI image options", cause)),
  )
  const images = request.images ?? []
  const editing = images.length > 0
  const gemini = request.model.id.startsWith("gemini-")
  if (request.n !== undefined && (request.n < 1 || request.n > 10))
    return yield* ProviderShared.invalidRequest("n must be between 1 and 10")
  if (gemini && (request.n ?? 1) > 1)
    return yield* route.unsupported("media.n", "VIPAI Gemini supports one image per request")
  if (gemini && options.quality !== undefined)
    return yield* ProviderShared.invalidRequest("quality is a GPT Image option; for Gemini use resolution")
  if (!editing && options.mask) return yield* ProviderShared.invalidRequest("A mask requires an input image")
  if (
    !gemini &&
    (options.mask ||
      images.length > 1 ||
      (editing && options.style) ||
      (editing && request.n !== undefined && request.n !== 1))
  )
    return yield* ProviderShared.invalidRequest("GPT edits support one input image and no mask, style or batch")
  if (gemini && !editing && request.resolution !== undefined)
    return yield* ProviderShared.invalidRequest("VIPAI Gemini resolution requires an input image")
  if (options.size !== undefined && (request.aspect !== undefined || request.resolution !== undefined))
    return yield* ProviderShared.invalidRequest("Use size or aspect/resolution, not both")

  // Shared sizing follows the model's pixel limits; explicit legacy aliases keep their existing mapping.
  const size =
    (gemini ? undefined : OpenAIImages.pixelSize(request)?.size) ?? mapSize(options.size ?? request.aspect, editing)
  const quality = mapQuality(options.quality, editing)
  if (!editing)
    return MediaProtocol.json({
      model: request.model.id,
      prompt: gemini && options.style ? `${request.prompt}\n\nStyle: ${options.style}` : request.prompt,
      size,
      n: request.n ?? 1,
      ...(gemini ? {} : { quality, ...(options.style ? { style: options.style } : {}), response_format: "url" }),
    })

  const form = new FormData()
  form.append("model", request.model.id)
  form.append("prompt", request.prompt)
  yield* Effect.forEach(images, (image, index) =>
    Effect.gen(function* () {
      form.append(
        index === 0 ? "image" : `image${index}`,
        MediaInput.blob(yield* MediaInput.inlineBytes(route.id, image), image.mediaType),
        `image-${index}`,
      )
    }),
  )
  if (gemini) {
    form.append("aspect_ratio", request.aspect ?? mapAspect(options.size ?? "16:9"))
    form.append("image_size", request.resolution ?? "4K")
    form.append("response_format", "url")
    form.append("n", "1")
    if (options.style) form.append("style", options.style)
    if (options.mask)
      form.append(
        "mask",
        MediaInput.blob(yield* MediaInput.inlineBytes(route.id, options.mask), options.mask.mediaType),
        "mask",
      )
  }
  if (!gemini) {
    form.append("size", size)
    form.append("quality", quality)
  }
  return MediaProtocol.multipart(form)
})

const decode = route.decodeJson(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({ url: Schema.optionalKey(Schema.String), b64_json: Schema.optionalKey(Schema.String) }),
    ),
  }),
)

export const protocol = MediaProtocol.inline<Request, ImageResponse>(route, {
  body: { from: fromRequest },
  response: {
    decode: Effect.fn("VIPAIImages.decode")(function* (response, context) {
      const output = yield* decode(response)
      const items = context.request.model.id.startsWith("gemini-") ? output.value.data.slice(0, 1) : output.value.data
      if (!items.length) return yield* output.invalid("VIPAI returned no images")
      return new ImageResponse({
        images: yield* Effect.forEach(items, (item) => {
          if (
            context.request.model.id.startsWith("gemini-") &&
            (!item.url || !URL.canParse(item.url) || new URL(item.url).protocol !== "https:")
          )
            return Effect.fail(output.invalid("VIPAI Gemini returned no HTTPS image URL"))
          if (item.url && (!URL.canParse(item.url) || !["https:", "http:"].includes(new URL(item.url).protocol)))
            return Effect.fail(output.invalid("VIPAI returned an invalid image URL"))
          return MediaInput.imageOutput(output.invalid, "VIPAI image", item.url ? { url: item.url } : item, undefined)
        }),
      })
    }),
  },
})

export const model = (input: MediaRoute.ModelInput) =>
  ImageModel.fromRoute<Options>(
    {
      protocol,
      baseURL: "https://new.vipai.me/v1",
      path: ({ request }) => (request.images?.length ? "/images/edits" : "/images/generations"),
    },
    input,
  )

function mapSize(size: string | undefined, editing: boolean) {
  const value = (size ?? (editing ? "16x9" : "1024x1024")).toLowerCase().replace(/\s/g, "")
  if (["16x9", "16:9", "3x2", "3:2"].includes(value)) return "1536x1024"
  if (["1x1", "1:1", "square"].includes(value)) return "1024x1024"
  if (["9x16", "9:16", "portrait"].includes(value)) return "1024x1536"
  return editing ? "auto" : value
}

function mapAspect(size: string) {
  if (["1024x1024", "square"].includes(size)) return "1:1"
  if (size === "1536x1024") return "3:2"
  if (size === "1024x1536") return "2:3"
  if (size === "portrait") return "9:16"
  return size.replace(/x/g, ":")
}

function mapQuality(quality: string | undefined, editing: boolean) {
  const value = (quality ?? (editing ? "2k" : "auto")).toLowerCase()
  if (value === "1k" || (editing && value === "hd")) return "low"
  if (value === "2k") return "medium"
  return value
}

export const VIPAIImages = { protocol, model } as const
