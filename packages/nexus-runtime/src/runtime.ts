import { Client, DeviceFlow, ExecutorClient, OAuthCredentials, Toolsets, type CredentialStore } from "@cybros/agent"
import { RealtimeClient } from "@cybros/agent/realtime"
import { mkdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Schema } from "effect"
import { atomic, missing, vault } from "./storage"
import type { HostTools } from "./host"
export { hostTools } from "./host"
import { ClaimJournal } from "./claims"
import { HumanLogin } from "./login"
import { readEffect, serveInbox, tools } from "./runner"

const ModeValues = Schema.Struct({ code_mode: Schema.Boolean, subagent: Schema.Boolean })

const Settings = Schema.Struct({
  origin: Schema.String,
  identifier: Schema.String,
  directory: Schema.String,
  workspace: Schema.String,
  model: Schema.String,
})

type Settings = typeof Settings.Type
type Identity = { agent: string; name: string; runner: string; workspace: string; workspaceName: string }
type Pairing = { code: string; url: string }
type Connection = { member: Client; candidates: ReadonlySet<string>; identity: Identity }

export type Status = {
  state: "unpaired" | "pairing" | "connecting" | "ready" | "error"
  origin: string
  model: string
  directory: string
  workspace: string
  identity?: Identity
  pairing?: Pairing
  error?: string
}

/** One owner, scoped to the elected OpenCode service. Browser and CLI clients share this instance. */
export class NexusRuntime {
  private stop = new AbortController()
  private readonly human: HumanLogin
  private readonly store: CredentialStore
  private work?: Promise<void>
  private pending?: Promise<Status>
  private settings?: Settings
  private connection?: Connection
  private credentials?: OAuthCredentials
  private statusValue: Status = { state: "unpaired", origin: "", model: "", directory: "", workspace: "" }

  constructor(
    private readonly storage: string,
    private readonly host?: HostTools,
  ) {
    this.human = new HumanLogin(join(storage, "human"))
    this.store = vault(join(storage, "agent.json"))
  }

  status() {
    return this.statusValue
  }

  async restore() {
    const settings = await readFile(join(this.storage, "settings.json"), "utf8").catch((error) => {
      if (missing(error)) return undefined
      throw error
    })
    if (!settings) return
    this.settings = Schema.decodeUnknownSync(Schema.fromJsonString(Settings))(settings)
    this.statusValue = this.view("unpaired")
    const authority = new DeviceFlow({ baseURL: this.settings.origin })
    const credentials = await OAuthCredentials.load({ authority, store: this.store })
    if (credentials) this.start(credentials, this.settings)
  }

  pair(input: Omit<Settings, "identifier">) {
    if (this.pending)
      return this.pending.then((status) => {
        if (status.origin !== new URL(input.origin).origin) throw new Error("Another Nexus origin is already pairing.")
        return status
      })
    this.pending = this.begin(input).finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async begin(input: Omit<Settings, "identifier">) {
    if (this.work || this.credentials) {
      if (this.settings?.origin === input.origin && this.statusValue.state === "pairing") return this.status()
      throw new Error("Disconnect the current installation before pairing again.")
    }
    const url = new URL(input.origin)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Enter a Nexus origin such as https://nexus.example.com.")
    const origin = url.origin
    const authority = new DeviceFlow({ baseURL: origin })
    if (!input.model.trim()) throw new Error("Enter a Nexus text model.")
    if (!isAbsolute(input.directory)) throw new Error("Select an absolute runner directory.")
    const directory = await realpath(input.directory)
    if (!(await stat(directory)).isDirectory()) throw new Error("Select a runner directory.")
    await mkdir(this.storage, { recursive: true, mode: 0o700 })
    const storage = await realpath(this.storage)
    const rel = relative(directory, storage)
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))
      throw new Error("Choose a project directory outside the credential store.")
    const inside = relative(storage, directory)
    if (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(".." + sep))
      throw new Error("Choose a project directory outside the credential store.")
    const settings = {
      ...input,
      origin,
      directory,
      model: input.model.trim(),
      workspace: input.workspace.trim(),
      identifier: this.settings?.origin === origin ? this.settings.identifier : "opencode." + crypto.randomUUID(),
    }
    await atomic(join(this.storage, "settings.json"), settings)
    this.settings = settings
    const auth = await authority.requestAuthorization({
      agent_identifier: settings.identifier,
      agent_display_name: "OpenCode",
      executor_display_name: "OpenCode Local",
    })
    this.statusValue = {
      ...this.view("pairing"),
      pairing: { url: auth.verification_uri_complete, code: auth.user_code },
    }
    const signal = this.stop.signal
    // DeviceFlow owns its poller. Cancel the ceremony at Nexus when this service stops.
    const cancel = () => {
      void authority.cancelAuthorization(auth).catch(() => {})
    }
    if (signal.aborted) cancel()
    else signal.addEventListener("abort", cancel, { once: true })
    this.work = authority
      .awaitCredentials(auth, { signal })
      .then(async (bundle) => {
        signal.removeEventListener("abort", cancel)
        const credentials = await OAuthCredentials.issue({ credentials: bundle, authority, store: this.store })
        this.credentials = credentials
        await this.run(credentials, settings, signal)
      })
      .catch((cause) => this.failed(cause))
      .finally(() => {
        signal.removeEventListener("abort", cancel)
        this.work = undefined
      })
    return this.status()
  }

  private view(state: Status["state"]): Status {
    const settings = this.settings
    return {
      state,
      origin: settings?.origin ?? "",
      model: settings?.model ?? "",
      workspace: settings?.workspace ?? "",
      directory: settings?.directory ?? "",
    }
  }

  private failed(cause: unknown) {
    if (!this.stop.signal.aborted)
      this.statusValue = {
        ...this.view("error"),
        error: cause instanceof Error ? cause.message : "Nexus connection failed.",
      }
  }

  private start(credentials: OAuthCredentials, settings: Settings) {
    this.credentials = credentials
    this.work = this.run(credentials, settings, this.stop.signal)
      .catch((cause) => this.failed(cause))
      .finally(() => {
        this.work = undefined
      })
  }

  private async run(credentials: OAuthCredentials, settings: Settings, signal: AbortSignal) {
    this.statusValue = this.view("connecting")
    const member = new Client({ baseURL: settings.origin, credentialProvider: credentials.provider("member") })
    const options = { baseURL: settings.origin, credentialProvider: credentials.provider("executor") }
    const executor = new ExecutorClient(options)
    const availableTools = tools.filter((tool) => this.host || (tool.name !== "bash" && tool.name !== "find"))
    const journal = new ClaimJournal(join(this.storage, "claims", settings.identifier))
    while (!signal.aborted) {
      try {
        const announced = await executor.announce(
          {
            services: {
              agent: { tools: [] },
              runner: {
                tools: [...availableTools, { name: "files_bytes", effect_profile: readEffect }],
                environment: { root: settings.directory },
              },
            },
          },
          { signal },
        )
        const runner = announced.executor.public_id
        const workspace = settings.workspace
          ? await member.workspaces.fetch(settings.workspace, { signal })
          : (
              await member.workspaces.create(
                { name: "OpenCode", access_mode: "private" },
                { signal, idempotencyKey: settings.identifier.slice("opencode.".length) },
              )
            ).workspace
        if (!settings.workspace) {
          settings = { ...settings, workspace: workspace.public_id }
          await atomic(join(this.storage, "settings.json"), settings)
          this.settings = settings
        }
        const available = new Set((await member.tools.list({ signal })).map((tool) => tool.canonical_name))
        const kernel = Toolsets.names(
          "orchestration",
          "conversation",
          "history",
          "memory",
          "images",
          "schedules",
        ).filter((name) => available.has(name))
        const candidates = await member.executors.list({ role: "runner" }, { signal })
        const profile = await member.profile.declareConfiguration(
          {
            configuration: {
              default_model: settings.model,
              approval_mode: "ask",
              prompt_mechanism: "default",
              kernel_tools: kernel,
              runner_executor_public_ids: [...new Set([runner, ...candidates.map((row) => row.public_id)])],
              runner_tool_names: availableTools.map((tool) => tool.name),
            },
          },
          { signal },
        )
        const identity = {
          agent: profile.member.public_id,
          name: profile.member.display_name ?? profile.member.handle,
          runner,
          workspace: workspace.public_id,
          workspaceName: workspace.name,
        }
        this.connection = { member, candidates: new Set([runner, ...candidates.map((row) => row.public_id)]), identity }
        this.statusValue = { ...this.view("ready"), identity }
        await this.listen(options, executor, runner, settings.directory, journal, signal)
      } catch (cause) {
        this.connection = undefined
        this.failed(cause)
        if (signal.aborted) return
        await delay(5000, undefined, { signal })
      }
    }
  }

  private async listen(
    options: { baseURL: string; credentialProvider: () => Promise<string> },
    executor: ExecutorClient,
    id: string,
    directory: string,
    journal: ClaimJournal,
    signal: AbortSignal,
  ) {
    await journal.recover(executor, signal)
    const socket = new RealtimeClient(options)
    const owner = new AbortController()
    const active = AbortSignal.any([signal, owner.signal])
    let wake = new AbortController()
    const notifications = (async () => {
      while (!active.aborted) {
        try {
          const subscription = await socket.executorInbox({ signal: active })
          wake.abort()
          for await (const _event of subscription) wake.abort()
        } catch {
          if (active.aborted) return
        }
        await socket.reconnect()
        await delay(5000, undefined, { signal: active })
      }
    })().catch(() => {})
    try {
      while (!signal.aborted) {
        wake = new AbortController()
        await serveInbox(executor, id, directory, journal, signal, this.host)
        await delay(5000, undefined, { signal: AbortSignal.any([active, wake.signal]) }).catch(() => {})
      }
    } finally {
      owner.abort()
      await socket.close()
      await notifications
    }
  }

  runners() {
    if (!this.connection) throw new Error("Nexus is disconnected.")
    const active = this.connection
    return active.member.executors
      .list({ role: "runner" })
      .then((rows) =>
        rows
          .filter((row) => active.candidates.has(row.public_id))
          .map((row) => ({ id: row.public_id, name: row.display_name || row.public_id })),
      )
  }

  async modes(workspace: string, conversation: string, patch?: { code_mode?: boolean; subagent?: boolean }) {
    const active = this.connection
    if (!active || workspace !== active.identity.workspace) throw new Error("The selected workspace is unavailable.")
    const chat = active.member.workspace(workspace).conversation(conversation)
    const info = await chat.fetch()
    if (info.answering_user_public_id !== active.identity.agent || info.side || (patch && info.archived_at))
      throw new Error("These conversation settings are unavailable.")
    let after: string | undefined
    do {
      const page = await chat.storeEntries.list({ after })
      const entry = page.items.find((row) => row.namespace === "opencode" && row.key === "modes")
      if (entry) {
        const saved = await chat.storeEntries.fetch(entry.public_id)
        const modes = Schema.decodeUnknownSync(ModeValues)(saved.value)
        if (!patch) return modes
        const next = { ...modes, ...patch }
        await chat.storeEntries.update(saved.public_id, { value: next, lock_version: saved.lock_version })
        return next
      }
      after = page.next_after ?? undefined
    } while (after)
    const defaults = { code_mode: true, subagent: true, ...patch }
    if (patch)
      await chat.storeEntries.create(
        { namespace: "opencode", key: "modes", value: defaults },
        { idempotencyKey: crypto.randomUUID() },
      )
    return defaults
  }

  async policy(workspace: string, conversation: string) {
    const active = this.connection
    if (!active || !this.settings || workspace !== active.identity.workspace)
      throw new Error("The selected workspace is unavailable.")
    const chat = await active.member.workspace(workspace).conversation(conversation).fetch()
    if (chat.answering_user_public_id !== active.identity.agent || chat.side || chat.archived_at)
      throw new Error("This conversation cannot receive input here.")
    const runner = chat.default_runner?.executor_public_id
    const modes = await this.modes(workspace, conversation)
    const assembly = await active.member.tools.assemble({
      conversation_public_id: conversation,
      default_runner_executor_public_id: runner ?? null,
    })
    const selected = assembly.tool_definitions.flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return []
      const fn = row.function
      if (!fn || typeof fn !== "object" || Array.isArray(fn) || typeof fn.name !== "string") return []
      if (!modes.code_mode && fn.name === "code") return []
      if (
        !modes.subagent &&
        (["spawn", "delegate_task", "nexus.conversation.spawn", "nexus.graph.delegate_task"].includes(fn.name) ||
          ["nexus.conversation.spawn", "nexus.graph.delegate_task"].includes(String(row.canonical)))
      )
        return []
      return [fn.name]
    })
    if (!runner) return { tools: selected, directory: null, runner: null }
    if (runner === active.identity.runner) return { tools: selected, directory: this.settings.directory, runner }
    const remote = await active.member.executors.fetch(runner)
    if (!remote.service_roles.includes("runner")) throw new Error("The selected runner is unavailable.")
    const directory = remote.services.runner?.environment.root
    if (typeof directory !== "string" || !directory.length) throw new Error("The remote runner has no bound directory.")
    return { tools: selected, directory, runner }
  }

  async catalog(kind: "schedules" | "memory" | "mcp", after?: string) {
    const active = this.connection
    if (!active) throw new Error("Nexus is disconnected.")
    const workspace = active.member.workspace(active.identity.workspace)
    if (kind === "schedules") {
      const page = await workspace.schedules.list({ after })
      return {
        items: page.items.map((row) => ({
          id: row.public_id,
          name: row.name ?? row.public_id,
          state: row.status,
          detail: row.next_run_at,
        })),
        next: page.next_after,
      }
    }
    if (kind === "memory") {
      const page = await workspace.memoryCollections.list({ after })
      return {
        items: page.items.map((row) => ({
          id: row.public_id,
          name: row.name ?? row.public_id,
          state: row.archived_at ? "archived" : "active",
          detail: row.description,
        })),
        next: page.next_after,
      }
    }
    const page = await active.member.mcpConnections.list({ after, agent_public_id: active.identity.agent })
    return {
      items: page.items.map((row) => ({
        id: row.public_id,
        name: row.name,
        state: row.available ? "available" : row.enabled ? "unavailable" : "disabled",
        detail: row.account_label,
      })),
      next: page.next_after,
    }
  }

  async login() {
    if (!this.settings || !this.connection) throw new Error("Connect the Nexus agent before signing in.")
    return this.human.start(this.settings.origin, this.settings.identifier)
  }

  async account() {
    if (!this.settings) return null
    return this.human.account(this.settings.origin)
  }

  async logout() {
    if (this.settings) await this.human.logout(this.settings.origin)
  }

  async disconnect() {
    await this.close()
    this.connection = undefined
    try {
      await this.logout()
      await this.credentials?.revoke()
    } catch (error) {
      this.statusValue = { ...this.view("error"), error: "Could not revoke the Nexus credential. Retry disconnect." }
      throw error
    }
    this.credentials = undefined
    this.stop = new AbortController()
    this.statusValue = this.view("unpaired")
    return this.status()
  }

  async close() {
    this.stop.abort()
    await this.human.close()
    await this.pending?.catch(() => {})
    await this.work
    await this.credentials?.drain()
  }
}
