import { Option, Predicate, Schema } from "effect"

export type ConfigInvalidError = {
  name: "ConfigInvalidError"
  data: {
    path?: string
    message?: string
    issues?: ReadonlyArray<{ message: string; path: readonly string[] }>
  }
}

export type ProviderModelNotFoundError = {
  name: "ProviderModelNotFoundError"
  data: {
    providerID: string
    modelID: string
    suggestions?: readonly string[]
  }
}

type Translator = (key: string, vars?: Record<string, string | number>) => string

function tr(translator: Translator | undefined, key: string, text: string, vars?: Record<string, string | number>) {
  if (!translator) return text
  const out = translator(key, vars)

  if (!out || out === key) return text

  return out
}

const configError = Schema.Struct({
  name: Schema.Literal("ConfigInvalidError"),
  data: Schema.Struct({
    path: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    issues: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String, path: Schema.Array(Schema.String) }))),
  }),
})

const modelError = Schema.Struct({
  name: Schema.Literal("ProviderModelNotFoundError"),
  data: Schema.Struct({
    providerID: Schema.String,
    modelID: Schema.String,
    suggestions: Schema.optional(Schema.Array(Schema.String)),
  }),
})

export function formatServerError(cause: unknown, translate?: Translator, fallback?: string) {
  const unwrapped = unwrapNamedError(cause)
  const config = Schema.decodeUnknownOption(configError)(unwrapped)

  if (Option.isSome(config)) return parseReadableConfigInvalidError(config.value, translate)
  const model = Schema.decodeUnknownOption(modelError)(unwrapped)

  if (Option.isSome(model)) return parseReadableProviderModelNotFoundError(model.value, translate)
  const message = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(unwrapped)

  if (Option.isSome(message) && message.value.message) return message.value.message

  if (cause instanceof Error && cause.message) return cause.message

  if (Predicate.isString(cause) && cause) return cause

  if (fallback) return fallback

  return tr(translate, "error.chain.unknown", "Unknown error")
}

// SAFETY: exceptions and transport causes can carry arbitrary values; each consumer decodes its own error contract.
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Preserve the raw cause until its owning error schema decodes it.
function unwrapNamedError(cause: unknown): unknown {
  if (!(cause instanceof Error) || !Predicate.isObjectOrArray(cause.cause)) return cause

  if (Predicate.hasProperty(cause.cause, "body")) return cause.cause.body

  return cause.cause
}

// Client-synthesized session not-found errors share one constructor and
// predicate so the message contract cannot drift between route session
// resolution (session-resolution.ts) and not-found fallback matching (session.tsx).
const sessionNotFoundMessage = (sessionID: string) => `Session not found: ${sessionID}`

export function sessionNotFoundError(sessionID: string) {
  return new Error(sessionNotFoundMessage(sessionID))
}

export function isLocalSessionNotFoundError(cause: unknown, sessionID: string) {
  return cause instanceof Error && cause.message === sessionNotFoundMessage(sessionID)
}

export function isSessionNotFoundError(cause: unknown, sessionID: string) {
  const unwrapped = unwrapNamedError(cause)
  const current = Schema.decodeUnknownOption(Schema.Struct({ sessionID: Schema.String }))(unwrapped)

  if (Predicate.isTagged(unwrapped, "SessionNotFoundError") && Option.isSome(current))
    return current.value.sessionID === sessionID

  const legacy = Schema.decodeUnknownOption(
    Schema.Struct({ name: Schema.Literal("NotFoundError"), data: Schema.Struct({ message: Schema.String }) }),
  )(unwrapped)

  return Option.isSome(legacy) && legacy.value.data.message === sessionNotFoundMessage(sessionID)
}

export function parseReadableConfigInvalidError(errorInput: ConfigInvalidError, translator?: Translator) {
  const file = errorInput.data.path && errorInput.data.path !== "config" ? errorInput.data.path : "config"
  const detail = errorInput.data.message?.trim() ?? ""

  const issues = (errorInput.data.issues ?? [])
    .map((issue) => {
      const msg = issue.message.trim()

      if (!issue.path.length) return msg

      return `${issue.path.join(".")}: ${msg}`
    })
    .filter(Boolean)

  const msg = issues.length ? issues.join("\n") : detail

  if (!msg) return tr(translator, "error.chain.configInvalid", `Config file at ${file} is invalid`, { path: file })

  return tr(translator, "error.chain.configInvalidWithMessage", `Config file at ${file} is invalid: ${msg}`, {
    path: file,
    message: msg,
  })
}

function parseReadableProviderModelNotFoundError(errorInput: ProviderModelNotFoundError, translator?: Translator) {
  const p = errorInput.data.providerID.trim()
  const m = errorInput.data.modelID.trim()
  const list = (errorInput.data.suggestions ?? []).map((v) => v.trim()).filter(Boolean)
  const body = tr(translator, "error.chain.modelNotFound", `Model not found: ${p}/${m}`, { provider: p, model: m })
  const tail = tr(translator, "error.chain.checkConfig", "Check your config (opencode.json) provider/model names")

  if (list.length) {
    const suggestions = list.slice(0, 5).join(", ")

    return [body, tr(translator, "error.chain.didYouMean", `Did you mean: ${suggestions}`, { suggestions }), tail].join(
      "\n",
    )
  }

  return [body, tail].join("\n")
}
