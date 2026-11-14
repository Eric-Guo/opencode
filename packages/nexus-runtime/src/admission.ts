import type { Client, CreateInput, JsonObject, RequestOptions } from "@cybros/agent"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { StoreDocument } from "./document"

const Admission = Schema.Struct({
  request: Schema.Record(Schema.String, Schema.MutableJson),
  body: Schema.Struct({
    kind: Schema.Literal("direct_reply"),
    answering_user_public_id: Schema.optional(Schema.String),
    speaker_public_id: Schema.optional(Schema.String),
    text: Schema.String,
    agent_configuration: Schema.Record(Schema.String, Schema.MutableJson),
    model: Schema.Struct({ model: Schema.String }),
    model_selection: Schema.Struct({
      source: Schema.Literals(["explicit", "default"]),
      model: Schema.String,
      constraint: Schema.Literals(["route", "any"]),
      alternatives: Schema.mutable(Schema.Array(Schema.String)),
    }),
    fallback_models: Schema.mutable(Schema.Array(Schema.String)),
    delivery_mode: Schema.optional(Schema.Literals(["queue", "steer", "steer_now"])),
    executor_contexts: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.MutableJson))),
    tool_names: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  }),
})
/** Preserve the first accepted policy through uncertain responses and service restarts. */
export class InputAdmissions {
  private readonly documents = new Map<string, StoreDocument<typeof Admission.Type>>()

  constructor(private readonly member: Client) {}

  async submit(
    input: { key: string; workspace: string; conversation: string; request: JsonObject },
    prepare: () => Promise<CreateInput>,
    author = this.member,
    options: RequestOptions = {},
  ) {
    const document =
      this.documents.get(input.key) ??
      new StoreDocument(
        this.member.profile.storeEntries,
        "opencode.input-admission",
        createHash("sha256").update(input.key).digest("hex"),
        Schema.decodeUnknownSync(Admission),
      )
    this.documents.set(input.key, document)
    const request = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)))(
      JSON.stringify(input.request),
    )
    const prior = await document.read()
    if (prior && !isDeepStrictEqual(prior.request, request))
      throw new Error("This input key belongs to another request.")
    const candidate = prior ?? {
      body: Schema.decodeUnknownSync(Schema.fromJsonString(Admission.fields.body))(JSON.stringify(await prepare())),
    }
    const admission = await document.change((current) => current ?? { request, body: candidate.body })
    if (!isDeepStrictEqual(admission.request, request)) throw new Error("This input key belongs to another request.")

    return author
      .workspace(input.workspace)
      .conversation(input.conversation)
      .inputs.create(admission.body, { ...options, idempotencyKey: input.key })
  }
}
