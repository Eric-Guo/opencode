import { APIError, type Client, type CreateInput, type JsonObject, type RequestOptions } from "@cybros/agent"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
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
type Admission = typeof Admission.Type
const namespace = "opencode.input-admission"
const decodeAdmission = Schema.decodeUnknownSync(Admission)
const parseAdmission = Schema.decodeUnknownSync(Schema.fromJsonString(Admission))

/** Preserve the first accepted policy through uncertain responses and service restarts. */
export class InputAdmissions {
  private readonly documents = new Map<string, StoreDocument<Admission>>()
  private readonly gates = new Map<string, Promise<void>>()
  private migration?: Promise<void>
  private readonly journal?: AdmissionJournal

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
    directory?: string,
  ) {
    if (directory) this.journal = new AdmissionJournal(directory)
  }

  async submit(
    input: { key: string; workspace: string; conversation: string; request: JsonObject },
    prepare: () => Promise<CreateInput & { admission_notes?: JsonObject }>,
    author = this.member,
    options: RequestOptions = {},
  ) {
    const body = await this.capture(input, prepare)
    const document = this.document(input.key)

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
      const tightened = await document.change((state) => ({
        ...state!,
        body: { ...state!.body, approval_mode: "rules" as const },
      }))

      return create(tightened.body)
    })
    const accepted = await document.change((state) => ({ ...state!, input: receipt.input.public_id }))
    if (receipt.input.state !== "blocked")
      void this.submitted?.(input, receipt.input.public_id, accepted.body, receipt.replayed).catch(() => {})
    return receipt
  }

  capture(
    input: { key: string; workspace: string; conversation: string; request: JsonObject },
    prepare: () => Promise<CreateInput & { admission_notes?: JsonObject }>,
  ) {
    const pending = (this.gates.get(input.key) ?? Promise.resolve()).then(() => this.prepare(input, prepare))
    const gate = pending.then(
      () => {},
      () => {},
    )
    this.gates.set(input.key, gate)

    return pending.finally(() => {
      if (this.gates.get(input.key) === gate) this.gates.delete(input.key)
    })
  }

  async notes(workspace: string, conversation: string, input: string | null) {
    if (!input) return {}
    for await (const row of this.records(workspace, conversation, input)) return row.value.notes ?? {}
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
    let selected: { at: string; value: Admission } | undefined

    for await (const row of this.records(workspace, conversation)) {
      if ((selected && row.at < selected.at) || !row.value.body.model) continue
      const addressedTo = row.value.notes?.["nexus.addressed"] ? row.value.body.answering_user_public_id : undefined
      if (initial && initial.addressedTo !== addressedTo) continue
      selected = row
    }
    return selected?.value
  }

  private async prepare(
    input: { key: string; workspace: string; conversation: string; request: JsonObject },
    prepare: () => Promise<CreateInput & { admission_notes?: JsonObject }>,
  ) {
    const document = this.document(input.key)
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

  private document(key: string) {
    const hash = createHash("sha256").update(key).digest("hex")
    if (this.journal) {
      const journal = this.journal
      return {
        read: async () => {
          await this.migrate(journal)
          return journal.read(hash)
        },
        change: async (edit: (current: Admission | null) => Admission) => {
          await this.migrate(journal)
          return journal.change(hash, edit)
        },
      }
    }

    const document =
      this.documents.get(key) ?? new StoreDocument(this.member.profile.storeEntries, namespace, hash, decodeAdmission)
    this.documents.set(key, document)
    return document
  }

  private async *records(workspace: string, conversation: string, input?: string) {
    if (this.journal) {
      await this.migrate(this.journal)
      yield* this.journal.records(workspace, conversation, input)
      return
    }

    for await (const row of this.legacyEntries()) {
      if (
        row.value.target?.workspace === workspace &&
        row.value.target.conversation === conversation &&
        (input === undefined || row.value.input === input)
      )
        yield { at: row.entry.created_at, value: row.value }
    }
  }

  private async *legacyEntries() {
    const store = this.member.profile.storeEntries
    let after: string | undefined
    do {
      const page = await store.list({ after, limit: 100 })
      for (const row of page.items.filter((row) => row.namespace === namespace)) {
        const entry = await store.fetch(row.public_id).catch((error: unknown) => {
          if (error instanceof APIError && error.status === 404) return
          throw error
        })
        if (entry) yield { entry, value: decodeAdmission(entry.value) }
      }
      after = page.next_after ?? undefined
    } while (after)
  }

  private migrate(journal: AdmissionJournal) {
    return (this.migration ??= journal
      .initialize()
      .then(async () => {
        // Copy every record before releasing its profile slot. A retry after an interrupted copy can resume safely.
        for await (const { entry, value } of this.legacyEntries()) {
          journal.import(entry.key, entry.created_at, entry.lock_version, value)
          await this.member.profile.storeEntries
            .delete(entry.public_id, { lock_version: entry.lock_version })
            .catch((error: unknown) => {
              if (!(error instanceof APIError && error.status === 404)) throw error
            })
        }
      })
      .catch((error: unknown) => {
        this.migration = undefined
        throw error
      }))
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

class AdmissionJournal {
  private readonly path: string

  constructor(private readonly directory: string) {
    this.path = join(directory, "admissions.sqlite3")
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    using db = new DatabaseSync(this.path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS admissions (
        key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        workspace TEXT,
        conversation TEXT,
        value TEXT NOT NULL,
        legacy_version INTEGER
      );
      CREATE INDEX IF NOT EXISTS admissions_target
        ON admissions (workspace, conversation, json_extract(value, '$.input'));
    `)
  }

  read(key: string) {
    using db = new DatabaseSync(this.path)
    return this.find(db, key)
  }

  change(key: string, edit: (current: Admission | null) => Admission) {
    using db = new DatabaseSync(this.path)
    db.exec("BEGIN IMMEDIATE")
    const current = this.find(db, key)
    const value = edit(current)

    if (!isDeepStrictEqual(current, value))
      db.prepare(
        `
        INSERT INTO admissions (key, created_at, workspace, conversation, value) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, legacy_version = NULL
      `,
      ).run(
        key,
        new Date().toISOString(),
        value.target?.workspace ?? null,
        value.target?.conversation ?? null,
        JSON.stringify(value),
      )
    db.exec("COMMIT")
    return value
  }

  import(key: string, at: string, version: number, value: Admission) {
    using db = new DatabaseSync(this.path)
    db.prepare(
      `
      INSERT INTO admissions (key, created_at, workspace, conversation, value, legacy_version) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, legacy_version = excluded.legacy_version
      WHERE admissions.legacy_version < excluded.legacy_version
    `,
    ).run(key, at, value.target?.workspace ?? null, value.target?.conversation ?? null, JSON.stringify(value), version)
  }

  records(workspace: string, conversation: string, input?: string) {
    using db = new DatabaseSync(this.path)
    const query = "SELECT created_at, value FROM admissions WHERE workspace = ? AND conversation = ?"
    const rows =
      input === undefined
        ? db.prepare(query + " ORDER BY key").all(workspace, conversation)
        : db.prepare(query + " AND json_extract(value, '$.input') = ? ORDER BY key").all(workspace, conversation, input)
    return rows.map((row) => ({ at: String(row.created_at), value: parseAdmission(row.value) }))
  }

  private find(db: DatabaseSync, key: string) {
    const row = db.prepare("SELECT value FROM admissions WHERE key = ?").get(key)
    return row ? parseAdmission(row.value) : null
  }
}

// Nexus reserves `instructions` for raw inputs; assembled requests carry authored leads inline.
function assembledInput(body: typeof Admission.Type.body, lead = body.instructions) {
  const result = { ...body }
  delete result.instructions
  if (lead) result.inline = [{ role: "developer", position: "lead", text: lead }, ...(body.inline ?? [])]
  return result
}
