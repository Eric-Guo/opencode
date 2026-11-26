import { Schema } from "effect"
import type { ExtensionModule } from "./extension-manager"

const Settings = Schema.Struct({
  auto_enable: Schema.Boolean,
  path: Schema.NonEmptyString,
  model: Schema.NullOr(Schema.String),
  every_turns: Schema.optional(Schema.Int),
})

export function memoryReviewExtension(): ExtensionModule {
  return {
    descriptor: {
      id: "nexus.memory-review",
      name: "Memory review",
      description: "Review completed replies into a selected scoped memory document.",
      default_enabled: true,
      configuration_version: 1,
      configuration_schema: {
        type: "object",
        properties: {
          auto_enable: {
            type: "boolean",
            title: "Consolidate memory automatically",
            description:
              "Enable periodic background memory consolidation on new conversations unless disabled per conversation.",
          },
          every_turns: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 1,
            title: "Consolidation cadence (turns)",
            description:
              "Completed turns between background memory consolidations (set to 5 for quiet periodic extraction).",
          },
          path: { type: "string", minLength: 1 },
          model: { type: ["string", "null"] },
        },
        required: ["auto_enable", "path", "model"],
        additionalProperties: false,
      },
      defaults: { auto_enable: false, path: "speaker/review.md", model: null, every_turns: 1 },
    },
    register(api) {
      const configuration = Schema.decodeUnknownSync(Settings)(api.configuration)
      const current: { owner?: AbortController; work?: Promise<void> } = {}
      api.on("member.connected", () => {
        current.owner?.abort()
        const owner = new AbortController()
        const application = api.application()
        current.owner = owner
        current.work = application.memoryReviews
          .watch(AbortSignal.any([api.signal, owner.signal]), configuration)
          .catch((error: unknown) => {
            if (!api.signal.aborted && !owner.signal.aborted) throw error
          })
        api.describeStatus(() => application.memoryReviews.status())
      })
      api.on("member.disconnected", () => current.owner?.abort())
      api.onShutdown(async () => {
        current.owner?.abort()
        await current.work
      })
      for (const name of [
        "memory-review.status",
        "memory-review.enable",
        "memory-review.disable",
        "memory-review.resume",
      ])
        api.registerCommand(name, (input) => api.application().memoryReviews.command(input))
    },
  }
}
