import { Schema } from "effect"

const Provider = Schema.Struct({
  instanceId: Schema.NonEmptyString,
  driver: Schema.NonEmptyString,
  displayName: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  availability: Schema.optional(Schema.String),
  status: Schema.String,
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      name: Schema.String,
      aliases: Schema.optional(Schema.Array(Schema.String)),
      isDefault: Schema.optional(Schema.Boolean),
      isCustom: Schema.optional(Schema.Boolean),
    }),
  ),
})
const harnesses: Record<string, string> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
}

export class T3Catalog {
  readonly providers

  constructor(value: unknown) {
    this.providers = Schema.decodeUnknownSync(Schema.Struct({ providers: Schema.Array(Provider) }))(
      value,
    ).providers.map((provider) => {
      const harness = harnesses[provider.driver] ?? provider.driver
      const reason = !provider.enabled
        ? "disabled"
        : provider.availability === "unavailable"
          ? "unavailable"
          : provider.status !== "ready"
            ? "not ready (" + provider.status + ")"
            : null
      return { ...provider, name: provider.displayName ?? harness, harness, reason }
    })
  }

  report() {
    return this.providers.map((provider) => ({
      agent: provider.name,
      harness: provider.harness,
      available: !provider.reason,
      reason: provider.reason,
      default_model: preferred(provider.models)?.slug ?? null,
      models: provider.models.map((model) => ({
        id: model.slug,
        name: model.name,
        aliases: [...(model.aliases ?? [])],
      })),
    }))
  }

  select(agent?: string, model?: string) {
    const choices = this.providers.filter((provider) =>
      agent
        ? [
            provider.name,
            provider.harness,
            provider.driver,
            ...(provider.driver === "claudeAgent" ? ["Claude"] : []),
          ].some((name) => name.toLowerCase() === agent.toLowerCase())
        : !provider.reason,
    )
    if (choices.length !== 1) throw new Error("Choose one available coding agent with coding_work action=agents.")
    const provider = choices[0]
    if (provider.reason) throw new Error(provider.name + " is " + provider.reason + ".")
    const exact = provider.models.filter((row) => row.slug === model)
    const named = provider.models.filter((row) => row.name.toLowerCase() === model?.toLowerCase())
    const models = !model
      ? [preferred(provider.models)].filter((row) => row !== undefined)
      : exact.length
        ? exact
        : named.length
          ? named
          : provider.models.filter((row) => row.aliases?.some((name) => name.toLowerCase() === model.toLowerCase()))
    if (models.length !== 1) throw new Error("Choose an available, unambiguous model for " + provider.name + ".")
    return { instanceId: provider.instanceId, agent: provider.name, harness: provider.harness, model: models[0].slug }
  }
}

function preferred(models: typeof Provider.Type.models) {
  return (
    models.find((model) => model.isDefault && !model.isCustom) ?? models.find((model) => !model.isCustom) ?? models[0]
  )
}
