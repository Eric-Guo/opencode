import { APIError, type Client, type Conversation, type RequestOptions } from "@cybros/agent"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import { StoreDocument } from "./document"

const Side = Schema.Struct({
  owner: Schema.String,
  parent: Schema.String,
  tools: Schema.Literals(["read", "write"]),
  opened_at: Schema.Number,
  last_turn_at: Schema.Number,
  model: Schema.optional(Schema.String),
})
const Opening = Schema.Struct({
  parent: Schema.String,
  workspace: Schema.String,
  key: Schema.String,
  at: Schema.Number,
  model: Schema.optional(Schema.String),
  conversation: Schema.optional(Schema.String),
  modes: Schema.Struct({ code_mode: Schema.Boolean, subagent: Schema.Boolean }),
})
export const sideLeads = {
  read: "You are in a side conversation: the turns above are the main conversation's history, inherited as reference only; answer the question below briefly, reading files if you must, and change nothing.",
  write:
    "You are in a side conversation: the turns above are the main conversation's history, inherited as reference only; handle the request below using the available tools and ordinary approvals. File changes affect the same working environment as the main conversation; coordinate overlapping edits.",
}
export const sideReadTools = ["read", "grep", "ls", "find", "read_process", "memory_read"]

/** Nexus owns the fork and reference history; this runtime owns its reusable side and posture. */
export class SideConversations {
  private readonly gates = new Map<string, Promise<unknown>>()
  private readonly states = new Map<string, StoreDocument<typeof Side.Type>>()
  private issue?: string

  constructor(
    private readonly client: Client,
    private readonly owner: string,
    private readonly hooks: {
      hosts(): readonly { workspace: string; conversation: string }[]
      prepare(workspace: string, conversation: string, foreign: boolean): Promise<{ model?: string }>
      copyEnvironment(workspace: string, parent: string, conversation: string, runner: string): Promise<unknown>
      adopt(workspace: string, conversation: string): void
      ended(workspace: string, conversation: string): Promise<void>
    },
  ) {}

  status() {
    return { ready: !this.issue, issues: this.issue ? [this.issue] : [] }
  }

  async open(
    input: { key: string; parent?: string; workspace?: string; tools?: "read" | "write" },
    options: RequestOptions = {},
  ) {
    const hosts = this.hooks.hosts()
    const selected = input.parent
      ? hosts.find(
          (host) => host.conversation === input.parent && (!input.workspace || input.workspace === host.workspace),
        )
      : await (async () => {
          for (const host of hosts.toReversed()) {
            const chat = await this.client.workspace(host.workspace).conversation(host.conversation).fetch(options)
            if (!chat.side && !chat.archived_at && !chat.metadata["opencode.bot"]) return host
          }
        })()
    // A side can be rediscovered through its persisted ownership even after its follower was lost.
    const workspace = selected?.workspace ?? input.workspace
    if (!workspace || (!selected && !input.parent)) throw new Error("Open or attach the parent conversation first.")
    const named = this.client.workspace(workspace).conversation(selected?.conversation ?? input.parent!)
    const document = await named.fetch(options)
    const policy = document.side ? await this.read(workspace, document.public_id) : null
    if (document.side && !policy) throw new Error("This side is not owned by this runtime.")
    if (!document.side && !selected) throw new Error("Open or attach the parent conversation first.")
    if (document.metadata["opencode.bot"])
      throw new Error("Side is unavailable for Bots; fork through the Bot's history.")
    const parent = policy?.parent ?? document.public_id
    const key = workspace + ":" + parent
    const pending = (this.gates.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const existing = policy
          ? document
          : (await this.rows(workspace, options)).find((row) => row.policy.parent === parent)?.conversation
        const opened = existing ?? (await this.create(workspace, document, input.key, options))
        const saved = await this.state(workspace, opened.public_id).change((state) => ({
          ...state!,
          tools: input.tools ?? "write",
        }))
        this.hooks.adopt(workspace, opened.public_id)
        return {
          conversation: opened,
          side: { public_id: opened.public_id },
          parent: { public_id: parent },
          reused: !!existing,
          tools: saved.tools,
          lead: sideLeads[saved.tools],
        }
      })
    this.gates.set(key, pending)
    void pending
      .finally(() => {
        if (this.gates.get(key) === pending) this.gates.delete(key)
      })
      .catch(() => {})
    return pending
  }

  async read(workspace: string, conversation: string) {
    const policy = await this.state(workspace, conversation).read()
    return policy?.owner === this.owner ? policy : null
  }

  async touch(workspace: string, conversation: string, at: number, model?: string) {
    const policy = await this.read(workspace, conversation)
    if (!policy) throw new Error("This side is not owned by this runtime.")
    await this.state(workspace, conversation).change((state) => ({
      ...state!,
      last_turn_at: Math.max(state!.last_turn_at, at),
      ...(model && at >= state!.last_turn_at ? { model } : {}),
    }))
  }

  async modes(workspace: string, conversation: string) {
    return (
      (await new StoreDocument(
        this.client.workspace(workspace).conversation(conversation).storeEntries,
        "opencode",
        "modes",
        Schema.decodeUnknownSync(Opening.fields.modes),
      ).read()) ?? { code_mode: true, subagent: true }
    )
  }

  async watch(signal: AbortSignal) {
    while (!signal.aborted) {
      await this.sweep(Date.now(), { signal })
        .then(() => {
          this.issue = undefined
        })
        .catch((error: unknown) => {
          if (!signal.aborted) this.issue = error instanceof Error ? error.message : "Side maintenance failed."
        })
      await setTimeout(60000, undefined, { signal })
    }
  }

  async sweep(now = Date.now(), options: RequestOptions = {}) {
    const workspaces = new Set(this.hooks.hosts().map((host) => host.workspace))
    for (const dedicated_to_current_agent of [false, true]) {
      let after: string | undefined
      do {
        const page = await this.client.workspaces.list({ dedicated_to_current_agent, after }, options)
        for (const workspace of page.items) workspaces.add(workspace.public_id)
        after = page.next_after ?? undefined
      } while (after)
    }
    const removed: string[] = []
    for (const workspace of workspaces) {
      for (const row of await this.rows(workspace, options)) {
        if (row.policy.last_turn_at > now - 86400000) {
          this.hooks.adopt(workspace, row.conversation.public_id)
          continue
        }
        const deleted = await this.client
          .workspace(workspace)
          .conversation(row.conversation.public_id)
          .delete(options)
          .then(() => true)
          .catch((error: unknown) => {
            if (error instanceof APIError && [404, 410].includes(error.status)) return true
            this.issue = error instanceof Error ? error.message : "Side cleanup failed."
            return false
          })
        if (!deleted) continue
        this.states.delete(workspace + ":" + row.conversation.public_id)
        await this.hooks.ended(workspace, row.conversation.public_id)
        removed.push(row.conversation.public_id)
      }
    }
    return removed
  }

  private state(workspace: string, conversation: string) {
    const key = workspace + ":" + conversation
    const document =
      this.states.get(key) ??
      new StoreDocument(
        this.client.workspace(workspace).conversation(conversation).storeEntries,
        "opencode.side",
        "policy/" + conversation,
        Schema.decodeUnknownSync(Side),
      )
    this.states.set(key, document)
    return document
  }

  private async rows(workspace: string, options: RequestOptions) {
    const result: { conversation: Conversation; policy: typeof Side.Type }[] = []
    let after: string | undefined
    do {
      const page = await this.client.workspace(workspace).conversations.list({ side: true, after }, options)
      for (const row of page.items) {
        await (async () => {
          const policy = await this.read(workspace, row.public_id)
          if (policy)
            result.push({
              conversation: await this.client.workspace(workspace).conversation(row.public_id).fetch(options),
              policy,
            })
        })().catch((error: unknown) => {
          if (!(error instanceof APIError && [404, 410].includes(error.status))) throw error
        })
      }
      after = page.next_after ?? undefined
    } while (after)
    return result
  }

  private async create(workspace: string, parent: Conversation, key: string, options: RequestOptions) {
    const document = new StoreDocument(
      this.client.profile.storeEntries,
      "opencode.side-opening",
      createHash("sha256")
        .update(workspace + ":" + parent.public_id)
        .digest("hex"),
      Schema.decodeUnknownSync(Opening),
    )
    const prior = await document.read()
    const reuse = prior?.conversation
      ? await this.client
          .workspace(workspace)
          .conversation(prior.conversation)
          .fetch(options)
          .catch((error: unknown) => {
            if (error instanceof APIError && [404, 410].includes(error.status)) return null
            throw error
          })
      : null
    if (reuse) {
      await this.initialize(workspace, parent, reuse, prior!)
      return reuse
    }
    const captured =
      prior && !prior.conversation
        ? prior
        : {
            parent: parent.public_id,
            workspace,
            key,
            at: Date.now(),
            ...(await this.hooks
              .prepare(workspace, parent.public_id, parent.answering_user_public_id !== this.owner)
              .then((value) => (value.model ? { model: value.model } : {}))),
            modes: await this.modes(workspace, parent.public_id),
          }
    if (Date.now() - captured.at >= 86400000)
      throw new Error("The side fork receipt expired; reconcile the original fork before opening another side.")
    await document.change(() => captured)
    const created = await this.client
      .workspace(workspace)
      .conversation(parent.public_id)
      .fork({ side: true }, { ...options, idempotencyKey: captured.key })
    await document.change((state) => ({ ...state!, conversation: created.conversation.public_id }))
    await this.initialize(workspace, parent, created.conversation, captured)
    return created.conversation
  }

  private async initialize(workspace: string, parent: Conversation, side: Conversation, captured: typeof Opening.Type) {
    await this.state(workspace, side.public_id).change(
      (state) =>
        state ?? {
          owner: this.owner,
          parent: parent.public_id,
          tools: "write",
          opened_at: captured.at,
          last_turn_at: captured.at,
          ...(captured.model ? { model: captured.model } : {}),
        },
    )
    await new StoreDocument(
      this.client.workspace(workspace).conversation(side.public_id).storeEntries,
      "opencode",
      "modes",
      Schema.decodeUnknownSync(Opening.fields.modes),
    ).change((state) => state ?? captured.modes)
    if (side.default_runner?.executor_public_id)
      await this.hooks.copyEnvironment(
        workspace,
        parent.public_id,
        side.public_id,
        side.default_runner.executor_public_id,
      )
  }
}
