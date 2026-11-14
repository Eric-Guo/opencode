import { APIError, type Client, type JsonObject, type Turn } from "@cybros/agent"
import { Schema } from "effect"
import { setTimeout } from "node:timers/promises"
import type { InputAdmissions } from "./admission"
import type { ExtensionLifecycle, TurnGate } from "./extension-lifecycle"

const terminal = new Set(["completed", "failed", "canceled"])

/** Lifecycle observation is independent of optional memory review and channel delivery. */
export class TurnLifecycle {
  private readonly hosts = new Map<
    string,
    { workspace: string; conversation: string; after: number; pending: string[] }
  >()
  private readonly followed = new Map<string, { notes: string; gate?: TurnGate }>()
  private readonly settled = new Set<string>()
  private readonly retired = new Set<string>()
  private issue?: string

  constructor(
    private readonly member: Client,
    private readonly owner: string,
    private readonly admissions: InputAdmissions,
    private readonly hooks?: ExtensionLifecycle,
    private readonly emit?: (name: string, value: Schema.Json) => Promise<void>,
  ) {}

  status() {
    return { ready: !this.issue, issues: this.issue ? [this.issue] : [] }
  }

  hostsSnapshot() {
    return [...this.hosts.values()].map((host) => ({ workspace: host.workspace, conversation: host.conversation }))
  }

  adopt(workspace: string, conversation: string) {
    const key = workspace + ":" + conversation
    this.retired.delete(key)
    if (!this.hosts.has(key)) this.hosts.set(key, { workspace, conversation, after: 0, pending: [] })
  }

  async watch(signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        await this.tick(signal).catch((error: unknown) => {
          if (!signal.aborted) this.issue = error instanceof Error ? error.message : "Lifecycle recovery failed."
        })
        await setTimeout(1000, undefined, { signal })
      }
    } finally {
      await Promise.allSettled([...this.followed.values()].map((row) => row.gate?.cancel?.()))
      this.followed.clear()
    }
  }

  async tick(signal: AbortSignal) {
    const owners = [
      this.owner,
      ...(await this.member.profile.agents.list({ signal }))
        .filter((agent) => agent.scope === "instance" && agent.name.startsWith("bot-"))
        .map((agent) => agent.public_id),
    ]
    let after: string | undefined
    do {
      const page = await this.member.conversations.list({ after, limit: 100, archived: true }, { signal })
      for (const row of page.items.filter((row) => owners.includes(row.answering_user_public_id) && !row.side)) {
        const key = row.workspace_public_id + ":" + row.public_id
        if (!this.hosts.has(key) && !this.retired.has(key))
          this.hosts.set(key, {
            workspace: row.workspace_public_id,
            conversation: row.public_id,
            after: 0,
            pending: [],
          })
      }
      after = page.next_after ?? undefined
    } while (after)
    for (const [key, host] of this.hosts) {
      const chat = this.member.workspace(host.workspace).conversation(host.conversation)
      await (async () => {
        const page = await chat.turns.list({ after_position: host.after, limit: 100, include_hidden: true }, { signal })
        const pending = await Promise.all(
          host.pending.map((id) =>
            chat.turns.fetch(id, { include_hidden: true }, { signal }).catch((error: unknown) => {
              if (error instanceof APIError && [404, 410].includes(error.status)) return null
              throw error
            }),
          ),
        )
        const turns = [
          ...new Map(
            [...pending.filter((row) => row !== null), ...page.items].map((turn) => [turn.public_id, turn]),
          ).values(),
        ]
        for (const turn of turns) await this.observe(host, turn, signal)
        host.after = Math.max(host.after, ...page.items.map((turn) => turn.position))
        host.pending = turns
          .filter(
            (turn) =>
              !terminal.has(turn.status) || !!this.followed.get(key + ":" + turn.active_variant?.run_public_id)?.gate,
          )
          .map((turn) => turn.public_id)
      })().catch(async (error: unknown) => {
        if (!(error instanceof APIError && [403, 404, 410].includes(error.status))) throw error
        this.hosts.delete(key)
        await this.ended(host.workspace, host.conversation)
      })
    }
    this.issue = undefined
  }

  async ended(workspace: string, conversation: string) {
    const identity = workspace + ":" + conversation
    if (this.retired.has(identity)) return
    this.retired.add(identity)
    this.hosts.delete(workspace + ":" + conversation)
    for (const [key, row] of this.followed) {
      if (!key.startsWith(workspace + ":" + conversation + ":")) continue
      await row.gate?.cancel?.()
      this.followed.delete(key)
    }
    await this.emit?.("host.ended", { workspace, conversation, host: conversation })
  }

  private async observe(host: { workspace: string; conversation: string }, turn: Turn, signal: AbortSignal) {
    if (turn.kind !== "direct_reply" || turn.inherited || turn.reference || !turn.active_variant) return
    const variant = turn.active_variant
    const run = variant.run_public_id
    if (run) {
      const key = host.workspace + ":" + host.conversation + ":" + run
      const notes = await this.admissions.notes(host.workspace, host.conversation, turn.input_public_id)
      const encoded = JSON.stringify(notes)
      const previous = this.followed.get(key)
      if (!previous || (!previous.gate && previous.notes !== encoded)) {
        const gate = await this.hooks?.follow({ ...host, turn: turn.public_id, run, notes })
        this.followed.set(key, { notes: encoded, ...(gate ? { gate } : {}) })
      }
      const gate = this.followed.get(key)?.gate
      if (gate && (!gate.run_public_id || gate.run_public_id === run)) {
        const snapshot = await this.member
          .workspace(host.workspace)
          .conversation(host.conversation)
          .execution({ turn_public_id: turn.public_id, variant_public_id: variant.public_id, run_public_id: run })
          .recover({ signal })
        if (snapshot)
          await Promise.resolve(gate.reconsider({ ...host, turn: turn.public_id, run, notes, snapshot, signal })).catch(
            (error: unknown) => {
              this.issue = error instanceof Error ? error.message : "Follow gate failed."
            },
          )
      }
    }
    if (!terminal.has(turn.status) || variant.status !== turn.status) return
    const identity = [host.workspace, host.conversation, turn.public_id, variant.public_id, turn.status].join(":")
    if (this.settled.has(identity)) return
    this.settled.add(identity)
    const settlement: JsonObject = {
      ...host,
      turn: turn.public_id,
      variant: variant.public_id,
      run,
      status: turn.status,
      model: variant.model ? variant.model.provider_id + "/" + variant.model.model_ref : null,
      memory_context: variant.memory_context,
    }
    // Observers receive published facts; slow hooks cannot delay a delivered outcome.
    void this.emit?.("turn.settled", settlement).catch(() => {})
  }
}
