import { APIError, type Client, type JsonObject, type StoreEntry } from "@cybros/agent"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { resolvePath } from "./file-read"
import { EditorBinding } from "./editor-bridge"

const Binding = Schema.Struct({
  root: Schema.NonEmptyString,
  directories: Schema.Array(Schema.String),
  anchor: Schema.NullOr(Schema.String),
})
type Binding = typeof Binding.Type
export const EnvironmentChange = Schema.Struct({
  root: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  directories: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  fs: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        url: Schema.String,
        token: Schema.String,
        read: Schema.optional(Schema.NullOr(Schema.Boolean)),
        write: Schema.optional(Schema.NullOr(Schema.Boolean)),
        client: Schema.NonEmptyString,
        session: Schema.optional(Schema.String),
      }),
    ),
  ),
  mcp: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
})
type Change = typeof EnvironmentChange.Type
type Resolved = { binding: Binding; source: "conversation" | "parent" | "default"; entry?: StoreEntry }
type Settings = {
  root?: () => string
  protectedRoots?: readonly string[]
  hosts?: () => readonly { workspace: string; conversation: string }[]
  mcp?: (workspace: string, anchor: string, root: string, entries: Schema.Json) => Promise<Schema.Json>
}

/** Current authoring defaults. Accepted task placement is always taken from its frozen context. */
export class Environments {
  private settings: Settings = {}
  private readonly records = new Map<
    string,
    { workspace: string; conversation: string; runner: string; resolved: Resolved }
  >()
  private readonly ports = new Map<string, EditorBinding>()
  private readonly servers = new Map<string, Schema.Json>()
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly member: Client,
    private readonly identity: { agent: string; runner: string; workspace: string },
  ) {}

  configure(settings: Settings) {
    this.settings = settings
  }

  async read(workspace: string, conversation: string, runner?: string) {
    const selected =
      runner ??
      (await this.member.workspace(workspace).conversation(conversation).fetch()).default_runner?.executor_public_id ??
      this.identity.runner
    return this.describe(workspace, conversation, selected, await this.resolve(workspace, conversation, selected))
  }

  async capture(workspace: string, conversation: string, runner: string): Promise<JsonObject> {
    const value = await this.resolve(workspace, conversation, runner)
    const port =
      runner === this.identity.runner && value.binding.anchor ? this.port(workspace, value.binding.anchor) : undefined
    return {
      "opencode.environment": {
        root: value.binding.root,
        directories: [...value.binding.directories],
        anchor: value.binding.anchor,
        ...(port ? { fs: { client: port.client ?? "editor", read: port.read, write: port.write } } : {}),
      },
    }
  }

  async copy(workspace: string, parent: string, conversation: string, runner: string) {
    const inherited = await this.resolve(workspace, parent, runner)
    return this.write(
      workspace,
      conversation,
      runner,
      { ...inherited.binding, anchor: inherited.binding.anchor ?? parent },
      true,
    )
  }

  async bind(workspace: string, conversation: string, input: Change, runner?: string) {
    const value = Schema.decodeUnknownSync(EnvironmentChange)(input)
    const chat = await this.member.workspace(workspace).conversation(conversation).fetch()
    const selected = runner ?? chat.default_runner?.executor_public_id ?? this.identity.runner
    const key = JSON.stringify([workspace, conversation, selected])
    const pending = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const before = await this.resolve(workspace, conversation, selected)
        const root = value.root === undefined ? before.binding.root : value.root
        const directories = value.directories ?? before.binding.directories
        const paths =
          root === null ? undefined : await this.validate(root, directories, selected === this.identity.runner)
        const port = value.fs
          ? Schema.decodeUnknownSync(EditorBinding)({
              ...value.fs,
              read: value.fs.read === true,
              write: value.fs.write === true,
              session: value.fs.session ?? conversation,
              roots: paths ? [paths.root, ...paths.directories] : [before.binding.root, ...before.binding.directories],
            })
          : undefined
        if (value.mcp !== undefined && !this.settings.mcp) throw new Error("Editor MCP registration is unavailable.")
        const store = this.member.workspace(workspace).conversation(conversation).storeEntries
        if (value.root === null) {
          for (let attempt = 0; attempt < 2; attempt++) {
            const entry = await this.record(workspace, conversation, selected)
            if (!entry) break
            const removed = await store
              .delete(entry.public_id, { lock_version: entry.lock_version })
              .then(() => true)
              .catch((error: unknown) => {
                if (error instanceof APIError && error.status === 409 && attempt === 0) return false
                throw error
              })
            if (removed) break
          }
          this.records.delete(key)
        } else if (value.root !== undefined || value.directories !== undefined) {
          await this.write(workspace, conversation, selected, {
            root: paths!.root,
            directories: paths!.directories,
            anchor: conversation,
          })
        }
        const current =
          value.root === null
            ? { binding: await this.defaults(selected), source: "default" as const }
            : await this.resolve(workspace, conversation, selected)
        if (port && selected !== this.identity.runner)
          throw new Error("runner_elsewhere: an editor filesystem port belongs to this machine's runner")
        if (!current.binding.anchor && (port || value.mcp?.length))
          throw new Error("environment_unbound: bind a root before attaching an editor filesystem or MCP servers")
        const anchor = current.binding.anchor ?? conversation
        const integration = JSON.stringify([workspace, anchor])
        if (value.fs === null) this.ports.delete(integration)
        if (port) this.ports.set(integration, port)
        if (value.mcp !== undefined)
          this.servers.set(integration, await this.settings.mcp!(workspace, anchor, current.binding.root, value.mcp))
        return this.describe(workspace, conversation, selected, current)
      })
    this.queues.set(key, pending)
    void pending
      .finally(() => {
        if (this.queues.get(key) === pending) this.queues.delete(key)
      })
      .catch(() => {})
    return pending
  }

  list() {
    const hosts = this.settings.hosts?.()
    return Promise.all(
      [...this.records.values()]
        .filter(
          (row) =>
            row.resolved.source !== "default" &&
            (!hosts ||
              hosts.some((host) => host.workspace === row.workspace && host.conversation === row.conversation)),
        )
        .map((row) => this.describe(row.workspace, row.conversation, row.runner, row.resolved)),
    )
  }

  port(workspace: string, anchor: string) {
    return this.ports.get(JSON.stringify([workspace, anchor]))
  }

  dropPort(workspace: string, anchor: string, expected?: EditorBinding) {
    const key = JSON.stringify([workspace, anchor])
    if (expected && this.ports.get(key) !== expected) return
    this.ports.delete(key)
  }

  async release(workspace: string, anchor: string) {
    const key = JSON.stringify([workspace, anchor])
    this.ports.delete(key)
    if (this.servers.delete(key)) {
      const root = [...this.records.values()].find(
        (row) => row.workspace === workspace && row.resolved.binding.anchor === anchor,
      )?.resolved.binding.root
      await this.settings.mcp?.(workspace, anchor, root ?? "", [])
    }
  }

  private async defaults(runner: string): Promise<Binding> {
    if (runner === this.identity.runner && this.settings.root)
      return { root: this.settings.root(), directories: [], anchor: null }
    const environment = (await this.member.executors.fetch(runner)).services.runner?.environment
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({ root: Schema.NonEmptyString, directories: Schema.optional(Schema.Array(Schema.String)) }),
    )(environment)
    return { root: parsed.root, directories: parsed.directories ?? [], anchor: null }
  }

  private async resolve(workspace: string, conversation: string, runner: string, depth = 0): Promise<Resolved> {
    if (depth > 8) throw new Error("executor_environment_unavailable: the parent chain is deeper than 8")
    const own = await this.record(workspace, conversation, runner)
    if (own) {
      const parsed = Schema.decodeUnknownSync(
        Schema.Struct({
          root: Schema.NonEmptyString,
          directories: Schema.optional(Schema.Array(Schema.String)),
          anchor: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      )(own.value)
      return this.remember(workspace, conversation, runner, {
        binding: { root: parsed.root, directories: parsed.directories ?? [], anchor: parsed.anchor ?? null },
        source: "conversation",
        entry: own,
      })
    }
    const parent = (await this.member.workspace(workspace).conversation(conversation).fetch()).parent
    if (parent) {
      const inherited = await this.resolve(workspace, parent.public_id, runner, depth + 1)
      if (inherited.source !== "default") {
        const entry = await this.write(workspace, conversation, runner, inherited.binding, true)
        const binding = Schema.decodeUnknownSync(Binding)(entry.value)
        return this.remember(workspace, conversation, runner, { binding, source: "parent", entry })
      }
    }
    return this.remember(workspace, conversation, runner, { binding: await this.defaults(runner), source: "default" })
  }

  private async record(workspace: string, conversation: string, runner: string) {
    const store = this.member.workspace(workspace).conversation(conversation).storeEntries
    let after: string | undefined
    do {
      const page = await store.list({ after })
      const entry = page.items.find((row) => row.namespace === "rho.environment" && row.key === "binding/" + runner)
      if (entry) return store.fetch(entry.public_id)
      after = page.next_after ?? undefined
    } while (after)
  }

  private async write(workspace: string, conversation: string, runner: string, binding: Binding, initialize = false) {
    const store = this.member.workspace(workspace).conversation(conversation).storeEntries
    const value = { root: binding.root, directories: [...binding.directories], anchor: binding.anchor }
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await this.record(workspace, conversation, runner)
      if (before && (initialize || isDeepStrictEqual(before.value, value))) return before
      const written = await (
        before
          ? store.update(before.public_id, { lock_version: before.lock_version, value })
          : store
              .create(
                { namespace: "rho.environment", key: "binding/" + runner, value },
                { idempotencyKey: crypto.randomUUID() },
              )
              .then((receipt) => receipt.store_entry)
      ).catch((error: unknown) => {
        if (
          error instanceof APIError &&
          error.status === 409 &&
          attempt === 0 &&
          ["key_taken", "stale_object"].includes(error.code ?? "")
        )
          return undefined
        throw error
      })
      if (written) return written
    }
    throw new Error("environment_contended: the environment record changed while being updated")
  }

  private async validate(root: string, directories: readonly string[], local: boolean) {
    const paths = await Promise.all(
      [root, ...directories].map(async (path) => {
        if (!local) {
          if (!isAbsolute(path)) throw new Error(path + " must be an absolute path on the selected Runner")
          return path
        }
        const canonical = await realpath(resolvePath(this.settings.root?.() ?? process.cwd(), path))
        if (!(await stat(canonical)).isDirectory()) throw new Error(path + " is not a directory")
        if (
          (this.settings.protectedRoots ?? []).some((root) => {
            const from = relative(root, canonical)
            return !isAbsolute(from) && from !== ".." && !from.startsWith(".." + sep)
          })
        )
          throw new Error(path + " is under a protected root")
        return canonical
      }),
    )
    return { root: paths[0]!, directories: paths.slice(1) }
  }

  private remember(workspace: string, conversation: string, runner: string, resolved: Resolved) {
    const key = JSON.stringify([workspace, conversation, runner])
    this.records.delete(key)
    this.records.set(key, { workspace, conversation, runner, resolved })
    if (this.records.size > 256) this.records.delete(this.records.keys().next().value!)
    return resolved
  }

  private async describe(workspace: string, conversation: string, runner: string, current: Resolved) {
    const port = current.binding.anchor ? this.port(workspace, current.binding.anchor) : undefined
    const resolved = await this.validate(current.binding.root, current.binding.directories, true)
      .then(() => true as boolean | "refused")
      .catch((error: unknown) =>
        error instanceof Error && error.message.includes("protected root") ? ("refused" as const) : false,
      )
    return {
      conversation,
      runner,
      root: current.binding.root,
      directories: [...current.binding.directories],
      anchor: current.binding.anchor,
      source: current.source,
      lock_version: current.entry?.lock_version ?? null,
      updated_at: current.entry?.updated_at ?? null,
      resolved,
      fs: port ? { client: port.client ?? "editor", read: port.read, write: port.write } : null,
      mcp: current.binding.anchor ? (this.servers.get(JSON.stringify([workspace, current.binding.anchor])) ?? []) : [],
    }
  }
}
