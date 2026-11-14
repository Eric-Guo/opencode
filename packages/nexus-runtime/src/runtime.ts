import {
  Client,
  DeviceFlow,
  ExecutorClient,
  OAuthCredentials,
  Toolsets,
  type AgentConfigurationInput,
  type CredentialStore,
  type JsonObject,
} from "@cybros/agent"
import { RealtimeClient } from "@cybros/agent/realtime"
import { mkdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep, win32, posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { NexusCommand, NexusOperator } from "@opencode/protocol/nexus-command"
import { Schema } from "effect"
import { atomic, missing, vault } from "./storage"
import type { HostTools } from "./host"
export { hostTools } from "./host"
import type { RunnerTool } from "./extensions"
import { builtinExtensions } from "./builtins"
import { Configuration } from "./configuration"
import { ExtensionManager } from "./extension-manager"
import type { Nexus } from "@opencode/schema/nexus"
import { Checkpoints } from "./checkpoints"
export type { NexusExtension, RunnerTool, RunnerContext } from "./extensions"
export type { ExtensionModule, ExtensionAPI } from "./extension-manager"
export type { ExtensionDescriptor } from "./configuration"
import { ClaimJournal } from "./claims"
import { webSite } from "./web"
import { HumanLogin } from "./login"
import { readEffect, RunnerAdmission, serveInbox, tools } from "./runner"

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
type Connection = {
  configuration: AgentConfigurationInput
  member: Client
  candidates: ReadonlySet<string>
  identity: Identity
}

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
  private readonly sites = new Set<string>()
  private declaring = Promise.resolve()
  private credentials?: OAuthCredentials
  private extensionManager?: ExtensionManager
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
    const refresh = (role: "agent" | "runner" = "runner") => [
      ...(role === "runner" ? tools.filter((tool) => this.host || !["bash", "find", "grep"].includes(tool.name)) : []),
      ...(this.extensionManager?.tools() ?? [])
        .filter((tool) => (tool.role ?? "runner") === role)
        .map((tool) => tool.definition),
    ]
    const applicationTools = () =>
      refresh("agent").map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description ?? undefined, parameters: tool.input_schema },
      }))
    this.extensionManager = new ExtensionManager(
      new Configuration(join(this.storage, "configuration.json")),
      await builtinExtensions(this.host),
      settings.directory,
      signal,
      async () => {
        await executor.announce(
          {
            services: {
              agent: { tools: refresh("agent") },
              runner: { tools: [...refresh(), ...hidden], environment: { root: settings.directory } },
            },
          },
          { signal },
        )

        const active = this.connection

        if (!active) return

        active.configuration = {
          ...active.configuration,
          runner_tool_names: refresh().map((tool) => tool.name),
          tool_definitions: applicationTools(),
        }
        await member.profile.declareConfiguration(
          { configuration: { ...active.configuration, approval_rules: this.siteRules() } },
          { signal },
        )
      },
    )
    const hidden = [
      { name: "files_bytes", effect_profile: readEffect },
      { name: "checkpoints", effect_profile: readEffect },
      {
        name: "checkpoint_restore",
        effect_profile: { ...readEffect, kind: "write" as const, destructive: true, idempotency: "none" as const },
      },
    ]
    await this.extensionManager.start()

    const names = [...refresh(), ...hidden].map((tool) => tool.name)
    if (new Set(names).size !== names.length) throw new Error("Nexus extensions must provide unique tool names.")
    const checkpoints = new Checkpoints(join(this.storage, "checkpoints", settings.identifier), settings.directory)
    const journal = new ClaimJournal(join(this.storage, "claims", settings.identifier))
    while (!signal.aborted) {
      try {
        const availableTools = refresh()
        const announced = await executor.announce(
          {
            services: {
              agent: { tools: refresh("agent") },
              runner: {
                tools: [...availableTools, ...hidden],
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
        // Reading a workspace does not imply this agent may write to it.
        if (workspace.dedicated) {
          let after: string | undefined
          do {
            const page = await member.workspaces.list(
              {
                dedicated_to_current_agent: true,
                state: ["archiving", "archived"].includes(workspace.state) ? "archived" : undefined,
                after,
              },
              { signal },
            )
            if (page.items.some((item) => item.public_id === workspace.public_id)) break
            after = page.next_after ?? undefined
            if (!after)
              throw new Error(
                `Nexus workspace "${workspace.name}" is dedicated to another agent. Disconnect and pair OpenCode with a different workspace, or leave Workspace ID blank to create one.`,
              )
          } while (after)
        }
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
        const imports = process.env.OPENCODE_NEXUS_MCP_IMPORTS
        const configuration: AgentConfigurationInput = {
          ...(imports
            ? {
                mcp_tools: Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.mutable(
                      Schema.Array(
                        Schema.Struct({
                          name: Schema.String,
                          tool_name: Schema.String,
                          connection_public_id: Schema.String,
                        }),
                      ),
                    ),
                  ),
                )(imports),
              }
            : {}),
          tool_definitions: applicationTools(),
          default_model: settings.model,
          approval_mode: "ask",
          prompt_mechanism: "default",
          kernel_tools: kernel,
          runner_executor_public_ids: [...new Set([runner, ...candidates.map((row) => row.public_id)])],
          runner_tool_names: availableTools.map((tool) => tool.name),
        }
        const profile = await member.profile.declareConfiguration(
          {
            configuration: { ...configuration, approval_rules: this.siteRules() },
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
        this.connection = {
          member,
          configuration,
          candidates: new Set([runner, ...candidates.map((row) => row.public_id)]),
          identity,
        }
        this.statusValue = { ...this.view("ready"), identity }
        const ingress = new AbortController()
        const token = process.env.OPENCODE_NEXUS_TELEGRAM_TOKEN
        const chats = process.env.OPENCODE_NEXUS_TELEGRAM_CHATS?.split(",")
          .map((id) => id.trim())
          .filter(Boolean)
        const bot =
          token && chats?.length
            ? (async () => {
                const { telegram } = await import("./telegram")
                await telegram({
                  token,
                  chats,
                  member,
                  workspace: workspace.public_id,
                  agent: identity.agent,
                  runner,
                  directory: settings.directory,
                  file: join(
                    this.storage,
                    "telegram-" + settings.identifier + "-" + token.split(":")[0].replace(/[^0-9]/g, "") + ".json",
                  ),
                  signal: AbortSignal.any([signal, ingress.signal]),
                })
              })()
            : undefined
        try {
          const inbox = this.listen(
            options,
            executor,
            runner,
            settings.directory,
            journal,
            AbortSignal.any([signal, ingress.signal]),
            checkpoints,
            () => this.extensionManager?.tools() ?? [],
          )
          if (bot) {
            try {
              await Promise.race([inbox, bot])
            } finally {
              ingress.abort()
              await Promise.allSettled([inbox, bot])
            }
          } else await inbox
        } finally {
          ingress.abort()
        }
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
    checkpoints: Checkpoints,
    extensions: () => readonly RunnerTool[],
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
    const admission = new RunnerAdmission(() => wake.abort())
    const programs = new Set<Promise<void>>()
    let failure: unknown
    const background = (work: Promise<void>) => {
      programs.add(work)
      void work
        .catch((error) => {
          failure = error
          owner.abort()
        })
        .finally(() => programs.delete(work))
    }
    try {
      while (!active.aborted) {
        wake = new AbortController()
        await serveInbox(
          executor,
          id,
          directory,
          journal,
          active,
          background,
          this.host,
          checkpoints,
          extensions(),
          admission,
        )
        await delay(5000, undefined, { signal: AbortSignal.any([active, wake.signal]) }).catch(() => {})
      }
      if (failure) throw failure
    } finally {
      owner.abort()
      await Promise.allSettled(programs)
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

  extensions() {
    return this.extensionManager?.list() ?? []
  }

  configureExtension(input: Nexus.ExtensionChange) {
    if (!this.extensionManager) throw new Error("Nexus is disconnected.")

    return this.extensionManager.change(input)
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

  async operator(input: typeof NexusOperator.Type) {
    const active = this.connection
    if (!active || input.workspace !== active.identity.workspace) throw new Error("Unknown paired workspace.")
    const workspace = active.member.workspace(input.workspace)
    const chat = await workspace.conversation(input.conversation).fetch()
    if (chat.side || chat.answering_user_public_id !== active.identity.agent || !active.candidates.has(input.runner))
      throw new Error("Unknown conversation or runner.")
    const operation = input.operation
    const args = await (async (): Promise<JsonObject> => {
      if (operation.tool === "files_bytes") {
        if (chat.default_runner?.executor_public_id !== input.runner) throw new Error("The runner binding changed.")
        const root = (await active.member.executors.fetch(input.runner)).services.runner?.environment.root
        if (typeof root !== "string" || !root) throw new Error("Unknown runner directory.")
        const paths = /^[a-z]:[\\/]|^\\\\/i.test(root) ? win32 : posix
        const path = paths.resolve(root, operation.path)
        const rel = paths.relative(root, path)
        if (!rel || paths.isAbsolute(rel) || rel.split(paths.sep).some((part) => part.startsWith(".")))
          throw new Error("Select a visible file inside the runner directory.")
        return { path }
      }
      if (chat.archived_at || input.runner !== active.identity.runner)
        throw new Error("This checkpoint is unavailable.")
      const run = workspace.run(operation.run)
      const info = await run.fetch()
      if (info.turn?.conversation_public_id !== chat.public_id) throw new Error("Unknown conversation run.")
      const detail = await run.task(operation.task).fetch()
      if (
        detail.task.target?.executor_public_id !== input.runner ||
        detail.task.status !== "completed" ||
        !["write", "edit", "bash"].includes(detail.task.tool_name ?? "")
      )
        throw new Error("Unknown local change.")
      const checkpoint = Schema.decodeUnknownSync(Schema.Struct({ hash: Schema.String, store: Schema.String }))(
        detail.metadata?.checkpoint,
      )
      return { checkpoint: checkpoint.hash, store: checkpoint.store }
    })()
    // An operator run is addressed by its creator. The paired agent owns its private runner.
    const run = await workspace.runs.startToolCall(
      { runner_executor_public_id: input.runner, tool: operation.tool, input: args, timeout_ms: 30000 },
      { idempotencyKey: input.receipt },
    )
    const result = await run.waitForToolResult({ patienceMs: 35000 })
    if (result.task.status !== "completed" || result.task.result?.is_error)
      throw new Error(result.output || "Runner operation failed.")
    if (operation.tool === "checkpoint_restore") return { upload: null }
    for (const block of Array.isArray(result.content) ? result.content : []) {
      if (
        block &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        block.type === "resource_link" &&
        typeof block.uri === "string" &&
        block.uri.startsWith("nexus://uploads/")
      )
        return { upload: block.uri.slice("nexus://uploads/".length) }
    }
    throw new Error("Runner file unavailable.")
  }

  async manage(command: typeof NexusCommand.Type, origin?: string, token?: string) {
    if (command.action === "extension.list") return this.extensions()
    if (command.action === "extension.configure") return this.configureExtension(command.change)

    const active = this.connection
    if (!active || !this.settings) throw new Error("Nexus is disconnected.")
    if (token && origin !== this.settings.origin)
      throw new Error("The Human credential requires the paired Nexus origin.")
    const member = token ? new Client({ baseURL: this.settings.origin, credential: token }) : active.member
    if (token && (await member.profile.fetch()).member.kind !== "human") throw new Error("Use a Human member token.")
    const workspace = member.workspace(active.identity.workspace)
    if ("conversation" in command) {
      const chat = workspace.conversation(command.conversation)
      const info = await chat.fetch()
      if (info.side || info.archived_at || info.answering_user_public_id !== active.identity.agent)
        throw new Error("Unknown active agent conversation.")
      const schedules = chat.schedules
      if (command.action === "schedule.create") {
        const policy = await this.policy(active.identity.workspace, command.conversation)
        return (
          await schedules.create(
            {
              prompt: command.prompt,
              name: command.name,
              rule: command.rule,
              answering_user_public_id: active.identity.agent,
              approval_mode: "ask",
              tool_names: policy.tools,
              ...(policy.runner && policy.directory
                ? { executor_contexts: { [policy.runner]: { "opencode.directory": policy.directory } } }
                : {}),
            },
            { idempotencyKey: command.key },
          )
        ).schedule
      }
      if (command.action === "schedule.update")
        return schedules.update(command.id, {
          expected_lock_version: command.version,
          rule: command.rule,
          prompt: command.prompt,
        })
      if (command.action === "schedule.read") return schedules.fetch(command.id)
      if (command.action === "schedule.pause") return schedules.pause(command.id)
      if (command.action === "schedule.resume") return schedules.resume(command.id)
      if (command.action === "schedule.cancel") return schedules.cancel(command.id)
      if (command.action === "schedule.run") return schedules.run(command.id)
      return schedules.executions(command.id)
    }
    const collections = workspace.memoryCollections
    if (command.action === "memory.create") return collections.create({ name: command.name })
    const collection = await collections.fetch(command.collection)
    if (collection.scope !== "workspace" || collection.owner_public_id !== active.identity.workspace)
      throw new Error("Select a memory collection from the paired workspace.")
    if (command.action === "memory.archive")
      return collections.archive(command.collection, { lock_version: command.version })
    if (command.action === "memory.restore")
      return collections.restore(command.collection, { lock_version: command.version })
    const docs = collections.documents(command.collection)
    if (command.action === "memory.list") return docs.list()
    if (command.action === "memory.read" && command.path) return docs.read(command.path)
    if (command.action === "memory.grep" && command.pattern)
      return docs.grep({ pattern: command.pattern, path: command.path })
    if (command.action === "memory.write")
      return docs.write({
        path: command.path,
        content: command.content,
        expected_public_id: command.id,
        expected_lock_version: command.version,
      })
    if (command.action === "memory.delete") {
      await docs.delete(command.path, { expected_public_id: command.id, expected_lock_version: command.version })
      return null
    }
    throw new Error("Memory reads require a path and searches require a pattern.")
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

  private siteRules() {
    return [...this.sites].map((site) => ({
      tool: "web_fetch",
      path: "url",
      match: site + "/*",
      verdict: "allow" as const,
    }))
  }

  grant(workspace: string, conversation: string, runID: string, key: string) {
    const active = this.connection
    const signal = this.stop.signal
    const pending = this.declaring.then(async () => {
      if (!active || active !== this.connection || workspace !== active.identity.workspace)
        throw new Error("Nexus connection changed.")
      const space = active.member.workspace(workspace)
      const run = space.run(runID)
      const [chat, data, detail] = await Promise.all([
        space.conversation(conversation).fetch(),
        run.fetch(),
        run.task(key).fetch(),
      ])
      if (
        chat.side ||
        chat.archived_at ||
        chat.answering_user_public_id !== active.identity.agent ||
        chat.metadata["opencode.surface"] !== "desktop" ||
        data.turn?.conversation_public_id !== conversation ||
        detail.task.tool_name !== "web_fetch" ||
        detail.task.target?.executor_public_id !== active.identity.runner ||
        !detail.task.approval ||
        typeof detail.task.approval !== "object" ||
        Array.isArray(detail.task.approval) ||
        detail.task.approval.origin !== "human" ||
        ["needs_approval", "failed", "canceled"].includes(detail.task.status)
      )
        throw new Error("This call cannot grant access to a site.")
      const site = webSite(detail.tool_input?.url)
      if (this.sites.has(site)) return
      const rule = { tool: "web_fetch", path: "url", match: site + "/*", verdict: "allow" as const }
      await active.member.profile.declareConfiguration(
        { configuration: { ...active.configuration, approval_rules: [...this.siteRules(), rule] } },
        { signal },
      )
      this.sites.add(site)
    })
    this.declaring = pending.catch(() => {})
    return pending
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
    const active = this.connection
    this.stop.abort()
    await this.declaring
    if (active && this.sites.size)
      await active.member.profile
        .declareConfiguration(
          { configuration: { ...active.configuration, approval_rules: [] } },
          { signal: AbortSignal.timeout(5000) },
        )
        .catch(() => {})
    this.sites.clear()
    await this.human.close()
    await this.pending?.catch(() => {})
    await this.work
    await this.extensionManager?.close()
    this.extensionManager = undefined
    await this.credentials?.drain()
  }
}
