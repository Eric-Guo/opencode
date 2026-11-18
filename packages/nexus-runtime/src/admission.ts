import { APIError, type Client, type CreateInput, type JsonObject, type RequestOptions } from "@cybros/agent"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { StoreDocument } from "./document"
import { TurnDraft, type ExtensionLifecycle } from "./extension-lifecycle"

const Admission = Schema.Struct({
  request: Schema.Record(Schema.String, Schema.MutableJson),
  target: Schema.optional(Schema.Struct({ workspace: Schema.String, conversation: Schema.String })),
  input: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
  body: Schema.Struct({
    kind: Schema.Literals(["direct_reply", "message"]),
    answering_user_public_id: Schema.optional(Schema.String),
    speaker_public_id: Schema.optional(Schema.String),
    text: Schema.String,
    attachments: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    instructions: Schema.optional(Schema.String),
    approval_mode: Schema.optional(Schema.Literals(["bypass", "ask", "rules"])),
    configuration: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    steps: Schema.optional(
      Schema.mutable(
        Schema.Array(
          Schema.Union([
            Schema.Struct({
              tool: Schema.Struct({
                name: Schema.String,
                key: Schema.String,
                input: Schema.Record(Schema.String, Schema.MutableJson),
                route: Schema.Struct({ kind: Schema.Literal("runner"), runner_executor_public_id: Schema.String }),
                executor_context: Schema.Record(Schema.String, Schema.MutableJson),
                timeout_ms: Schema.Number,
                on_failure: Schema.Literal("absorb"),
              }),
            }),
            Schema.Struct({
              ask: Schema.Struct({ key: Schema.String, prompt: Schema.String, indefinite: Schema.Boolean }),
            }),
          ]),
        ),
      ),
    ),
    inline: Schema.optional(
      Schema.mutable(
        Schema.Array(
          Schema.Struct({
            role: Schema.Literals(["user", "developer"]),
            position: Schema.Literals(["lead", "tail"]),
            text: Schema.String,
          }),
        ),
      ),
    ),
    agent_configuration: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    model: Schema.optional(Schema.Struct({ model: Schema.String })),
    model_selection: Schema.optional(
      Schema.Struct({
        source: Schema.Literals(["explicit", "default"]),
        model: Schema.String,
        constraint: Schema.Literals(["route", "any"]),
        alternatives: Schema.mutable(Schema.Array(Schema.String)),
      }),
    ),
    fallback_models: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    delivery_mode: Schema.optional(Schema.Literals(["queue", "steer", "steer_now"])),
    deliver_at: Schema.optional(Schema.String),
    deliver_in: Schema.optional(Schema.String),
    expected_steering_run_public_id: Schema.optional(Schema.String),
    executor_contexts: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.MutableJson))),
    tool_names: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  }),
})
/** Preserve the first accepted policy through uncertain responses and service restarts. */
export class InputAdmissions {
  private readonly documents = new Map<string, StoreDocument<typeof Admission.Type>>()
  private readonly gates = new Map<string, Promise<unknown>>()

  constructor(
    private readonly member: Client,
    private readonly lifecycle?: Pick<ExtensionLifecycle, "author" | "describeEnvironment">,
    private readonly accepted?: (
      input: { workspace: string; conversation: string },
      notes: JsonObject,
    ) => Promise<void>,
    private readonly submitted?: (
      target: { workspace: string; conversation: string },
      input: string,
      body: CreateInput,
      replayed: boolean,
    ) => Promise<void>,
  ) {}

  async submit(
    input: { key: string; workspace: string; conversation: string; request: JsonObject },
    prepare: () => Promise<CreateInput & { admission_notes?: JsonObject }>,
    author = this.member,
    options: RequestOptions = {},
  ) {
    const body = await this.capture(input, prepare)

    const create = (body: CreateInput) =>
      author
        .workspace(input.workspace)
        .conversation(input.conversation)
        .inputs.create(body, {
          ...options,
          idempotencyKey: input.key,
        })
    const receipt = await create(body).catch(async (error: unknown) => {
      if (
        body.approval_mode !== "ask" ||
        !(error instanceof APIError) ||
        !(
          (error.code === "validation_failed" && error.message.includes("only tightens the declaring profile")) ||
          error.code === "idempotency_envelope_mismatch"
        )
      )
        throw error

      // A stricter declaring profile refuses ask before accepting an input. Persist the
      // tightened envelope so retries after a lost rules response use the same bytes.
      const tightened = await this.documents.get(input.key)!.change((state) => ({
        ...state!,
        body: { ...state!.body, approval_mode: "rules" as const },
      }))

      return create(tightened.body)
    })
    const accepted = await this.documents
      .get(input.key)!
      .change((state) => ({ ...state!, input: receipt.input.public_id }))
    if (receipt.input.state !== "blocked")
      void this.submitted?.(input, receipt.input.public_id, accepted.body, receipt.replayed).catch(() => {})
    return receipt
  }

  capture(
    input: { key: string; workspace: string; conversation: string; request: JsonObject },
    prepare: () => Promise<CreateInput & { admission_notes?: JsonObject }>,
  ) {
    const pending = (this.gates.get(input.key) ?? Promise.resolve()).then(() => this.prepare(input, prepare))
    this.gates.set(
      input.key,
      pending.then(
        () => {},
        () => {},
      ),
    )
    return pending
  }

  async notes(workspace: string, conversation: string, input: string | null) {
    if (!input) return {}
    let after: string | undefined
    do {
      const page = await this.member.profile.storeEntries.list({ after, limit: 100 })
      for (const row of page.items.filter((row) => row.namespace === "opencode.input-admission")) {
        const value = Schema.decodeUnknownSync(Admission)(
          (await this.member.profile.storeEntries.fetch(row.public_id)).value,
        )
        if (
          value.input === input &&
          value.target?.workspace === workspace &&
          value.target.conversation === conversation
        )
          return value.notes ?? {}
      }
      after = page.next_after ?? undefined
    } while (after)
    return {}
  }

  async latestModel(workspace: string, conversation: string) {
    return (await this.latest(workspace, conversation))?.body.model?.model
  }

  async modelSelection(workspace: string, conversation: string, initial?: { model: string; addressedTo?: string }) {
    const latest = await this.latest(workspace, conversation, initial)
    if (latest?.notes?.["nexus.addressed"] && !initial?.addressedTo) return
    if (latest?.body.model_selection)
      return latest.body.model_selection.source === "explicit" ? latest.body.model_selection : undefined

    // Foreign agents receive only the model reference. Their input can still replace the opening choice.
    const model = latest ? (initial?.addressedTo ? latest.body.model?.model : undefined) : initial?.model
    if (model) return { source: "explicit" as const, constraint: "route" as const, model, alternatives: [] }
  }

  private async latest(workspace: string, conversation: string, initial?: { addressedTo?: string }) {
    let selected: { at: string; value: typeof Admission.Type } | undefined
    let after: string | undefined
    do {
      const page = await this.member.profile.storeEntries.list({ after, limit: 100 })
      for (const row of page.items.filter((row) => row.namespace === "opencode.input-admission")) {
        if (selected && row.created_at < selected.at) continue
        const value = Schema.decodeUnknownSync(Admission)(
          (await this.member.profile.storeEntries.fetch(row.public_id)).value,
        )
        if (value.target?.workspace !== workspace || value.target.conversation !== conversation || !value.body.model)
          continue
        const addressedTo = value.notes?.["nexus.addressed"] ? value.body.answering_user_public_id : undefined
        if (initial && initial.addressedTo !== addressedTo) continue
        selected = { at: row.created_at, value }
      }
      after = page.next_after ?? undefined
    } while (after)
    return selected?.value
  }

  private async prepare(
    input: { key: string; workspace: string; conversation: string; request: JsonObject },
    prepare: () => Promise<CreateInput & { admission_notes?: JsonObject }>,
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
    const candidate = prior ?? (await this.author(await prepare()))
    const admission = await document.change(
      (current) =>
        current ?? {
          request,
          body: candidate.body,
          notes: candidate.notes ?? {},
          target: { workspace: input.workspace, conversation: input.conversation },
        },
    )
    if (!isDeepStrictEqual(admission.request, request)) throw new Error("This input key belongs to another request.")
    await this.accepted?.(input, admission.notes ?? {})

    return admission.body
  }

  private async author(input: CreateInput & { admission_notes?: JsonObject }) {
    const body = Schema.decodeUnknownSync(Schema.fromJsonString(Admission.fields.body))(JSON.stringify(input))
    if (!this.lifecycle || body.kind !== "direct_reply" || input.admission_notes?.["nexus.addressed"])
      return { body: assembledInput(body), notes: input.admission_notes ?? {} }
    const environment = body.executor_contexts ?? {}
    const description = input.admission_notes?.["nexus.side"]
      ? ""
      : await this.lifecycle.describeEnvironment(environment)
    const draft = await this.lifecycle.author(
      Schema.decodeUnknownSync(TurnDraft)({
        body,
        environment,
        lead: [body.instructions, description].filter(Boolean).join("\n\n"),
        notes: input.admission_notes ?? {},
        tools: Array.isArray(body.agent_configuration?.tool_definitions)
          ? body.agent_configuration.tool_definitions
          : [],
        ...(body.steps ? { steps: body.steps } : {}),
      }),
    )
    return {
      body: assembledInput(
        Schema.decodeUnknownSync(Admission.fields.body)({
          ...draft.body,
          ...(draft.steps ? { steps: draft.steps } : {}),
        }),
        draft.lead,
      ),
      notes: draft.notes,
    }
  }
}

// Nexus reserves `instructions` for raw inputs; assembled requests carry authored leads inline.
function assembledInput(body: typeof Admission.Type.body, lead = body.instructions) {
  const result = { ...body }
  delete result.instructions
  if (lead) result.inline = [{ role: "developer", position: "lead", text: lead }, ...(body.inline ?? [])]
  return result
}
