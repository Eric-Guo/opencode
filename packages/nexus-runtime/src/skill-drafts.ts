import type { Client } from "@cybros/agent"
import { Schema } from "effect"
import { changeDocument, StoreDocument } from "./document"

export const skillDraftsNamespace = "rho.skill_drafts"
export const skillDraftsKey = "catalog"
export const skillScopes = ["agent", "workspace"]
export const skillNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
export const maxDescriptionBytes = 1024
export const maxContentBytes = 65536
export const maxDrafts = 32

export class SkillDraftsError extends Error {}

const DraftRow = Schema.Struct({
  public_id: Schema.String,
  name: Schema.String,
  scope: Schema.String,
  description: Schema.String,
  content: Schema.String,
  conversation_public_id: Schema.optional(Schema.String),
  workspace_public_id: Schema.optional(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})
export type SkillDraft = typeof DraftRow.Type

const StoredCatalog = Schema.Struct({ drafts: Schema.optional(Schema.Array(DraftRow)) })
type Catalog = { readonly drafts: readonly SkillDraft[] }

const decodeCatalog = (value: unknown): Catalog => ({
  drafts: Schema.decodeUnknownSync(StoredCatalog)(value ?? {}).drafts ?? [],
})

/**
 * Pending skill proposals awaiting human review before publication into an Agent or Workspace
 * MemoryCollection. Only the catalog lives here; approval writes skills through the operations layer.
 */
export class SkillDrafts {
  private readonly document: StoreDocument<Catalog>

  constructor(
    store: Client["profile"]["storeEntries"],
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.document = new StoreDocument(store, skillDraftsNamespace, skillDraftsKey, decodeCatalog)
  }

  async list(): Promise<SkillDraft[]> {
    return [...((await this.document.read())?.drafts ?? [])]
  }

  async fetch(publicId: string): Promise<SkillDraft> {
    const row = (await this.list()).find((entry) => entry.public_id === publicId)

    if (!row) throw new SkillDraftsError("No skill draft with public id " + publicId)
    return row
  }

  async propose(input: {
    name: string
    scope: string
    description: string
    content: string
    conversation_public_id?: string
    workspace_public_id?: string
  }): Promise<SkillDraft> {
    const normalized = validate(input)
    const now = iso8601(this.clock())
    let savedId = ""

    const saved = await changeDocument(this.document, (current) => {
      const drafts = [...(current?.drafts ?? [])]
      const existing = drafts.find((row) => row.scope === normalized.scope && row.name === normalized.name)

      if (existing) {
        savedId = existing.public_id
        drafts[drafts.indexOf(existing)] = { ...existing, ...normalized, updated_at: now }
        return { drafts }
      }
      if (drafts.length >= maxDrafts)
        throw new SkillDraftsError(
          "Too many pending skill drafts (max " + maxDrafts + "); approve or dismiss existing drafts first",
        )

      savedId = crypto.randomUUID()
      return { drafts: [...drafts, { ...normalized, public_id: savedId, created_at: now, updated_at: now }] }
    })

    return saved.drafts.find((row) => row.public_id === savedId)!
  }

  async remove(publicId: string): Promise<SkillDraft> {
    let removed: SkillDraft | undefined

    await changeDocument(this.document, (current) => {
      const drafts = [...(current?.drafts ?? [])]
      const found = drafts.find((row) => row.public_id === publicId)

      if (!found) throw new SkillDraftsError("No skill draft with public id " + publicId)
      removed = found
      return { drafts: drafts.filter((row) => row.public_id !== publicId) }
    })
    return removed!
  }
}

function validate(input: {
  name: string
  scope: string
  description: string
  content: string
  conversation_public_id?: string
  workspace_public_id?: string
}): {
  name: string
  scope: string
  description: string
  content: string
  conversation_public_id?: string
  workspace_public_id?: string
} {
  const scope = input.scope.trim()

  if (!skillScopes.includes(scope)) throw new SkillDraftsError("scope must be agent or workspace")

  const name = input.name.trim()

  if (!skillNamePattern.test(name))
    throw new SkillDraftsError("skill name must match lowercase [a-z0-9] with single hyphens (max 64 chars)")

  const description = input.description.trim()

  if (description === "" || Buffer.byteLength(description) > maxDescriptionBytes)
    throw new SkillDraftsError("description is required and must fit within " + maxDescriptionBytes + " UTF-8 bytes")

  if (input.content.trim() === "" || Buffer.byteLength(input.content) > maxContentBytes)
    throw new SkillDraftsError("content is required and must fit within " + maxContentBytes + " UTF-8 bytes")

  const conversation = presence(input.conversation_public_id)
  const workspace = presence(input.workspace_public_id)

  return {
    name,
    scope,
    description,
    content: input.content,
    ...(conversation ? { conversation_public_id: conversation } : {}),
    ...(workspace ? { workspace_public_id: workspace } : {}),
  }
}

function presence(value: string | undefined): string | undefined {
  const clean = value?.trim() ?? ""

  return clean === "" ? undefined : clean
}

// rho stamps entries with Time#iso8601, which is UTC at whole-second precision.
function iso8601(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}
