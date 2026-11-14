import { APIError, type Client } from "@cybros/agent"
import { readFile, rm } from "node:fs/promises"
import { Schema } from "effect"
import { atomic, missing } from "./storage"

/** Operator selection affects new hosts; changing a host default leaves accepted tasks untouched. */
export class Runners {
  private settings: {
    storage?: string
    hosts?: () => readonly { workspace: string; conversation: string }[]
    refresh?: (ids: string[]) => Promise<void>
  } = {}
  private selection: string | null = null
  private queue = Promise.resolve()

  constructor(
    private readonly member: Client,
    private readonly own: string,
  ) {}

  configure(settings: typeof this.settings) {
    this.settings = settings
  }

  async default() {
    return (await this.selected()) ?? this.own
  }

  async list() {
    const listed = await this.member.executors.list({ role: "runner" })
    const selected = await this.selected()
    const bindings = await Promise.all(
      (this.settings.hosts?.() ?? []).map(async (host) => {
        const row = await this.member
          .workspace(host.workspace)
          .conversation(host.conversation)
          .fetch()
          .catch((error: unknown) => {
            if (error instanceof APIError && [403, 404, 410].includes(error.status)) return undefined
            throw error
          })
        return { conversation: host.conversation, runner: row?.default_runner?.executor_public_id }
      }),
    )
    await this.settings.refresh?.(listed.map((row) => row.public_id))
    return {
      selection: selected,
      runners: listed.map((row) => ({
        public_id: row.public_id,
        display_name: row.display_name,
        presence: row.presence,
        last_seen_at: row.last_seen_at,
        root: typeof row.services.runner?.environment.root === "string" ? row.services.runner.environment.root : null,
        tools: row.services.runner?.tools.map((tool) => tool.name) ?? [],
        own: row.public_id === this.own,
        selected: row.public_id === selected,
        default_hosts: bindings.filter((host) => host.runner === row.public_id).map((host) => host.conversation),
      })),
    }
  }

  select(runner: string | null) {
    const operation = this.queue.then(async () => {
      if (runner && !(await this.list()).runners.some((row) => row.public_id === runner))
        throw new Error(runner + " is not a runner this profile may address")
      if (this.settings.storage) {
        if (runner) await atomic(this.settings.storage, { runner })
        else await rm(this.settings.storage, { force: true })
      }
      this.selection = runner
      return { selection: runner, runner: runner ?? this.own }
    })
    this.queue = operation.then(
      () => {},
      () => {},
    )
    return operation
  }

  async set(workspace: string, host: string, runner: string | null, kind?: "conversation" | "run") {
    if (runner) {
      const found = await this.member.executors.fetch(runner)
      if (!found.service_roles.includes("runner")) throw new Error(runner + " is not a runner this profile may address")
    }
    const chat =
      kind === "run"
        ? undefined
        : await this.member
            .workspace(workspace)
            .conversation(host)
            .fetch()
            .catch((error: unknown) => {
              if (kind === undefined && error instanceof APIError && error.status === 404) return undefined
              throw error
            })
    if (chat) {
      const changed = await this.member.workspace(workspace).conversation(host).setDefaultRunner(runner)
      await this.list()
      return {
        host: { type: "conversation", public_id: host },
        default_runner: changed.default_runner,
        previous: chat.default_runner?.executor_public_id ?? null,
      }
    }
    const run = await this.member.workspace(workspace).run(host).fetch()
    const changed = await this.member.workspace(workspace).run(host).setDefaultRunner(runner)
    await this.list()
    return {
      host: { type: "run", public_id: host },
      default_runner: changed.default_runner,
      previous: run.default_runner?.executor_public_id ?? null,
    }
  }

  private async selected() {
    if (!this.settings.storage) return this.selection
    const stored = await readFile(this.settings.storage, "utf8").catch((error: unknown) => {
      if (missing(error)) return undefined
      throw error
    })
    return stored === undefined
      ? null
      : Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ runner: Schema.NullOr(Schema.NonEmptyString) })),
        )(stored).runner
  }
}
