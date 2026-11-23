import { executionSnapshot } from "./execution"
import { RegisteredAgents } from "./registered-agents"
import { runnerEnvironment } from "./runner-environment"
import {
  APIError,
  AuthorizationLost,
  ConnectionSuperseded,
  Client,
  DeviceFlow,
  ExecutorClient,
  OAuthCredentials,
  APIKeyCredentials,
  decodeCredentialDocument,
  type AgentConfigurationInput,
  type Conversation,
  type CredentialStore,
  type JsonObject,
  type RequestOptions,
} from "@cybros/agent"
import { RealtimeClient } from "@cybros/agent/realtime"
import { createHash } from "node:crypto"
import { mkdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep, win32, posix } from "node:path"
import { scheduler } from "node:timers/promises"
import type { NexusCommand, NexusOperator } from "@opencode/protocol/nexus-command"
import { Schema } from "effect"
import { atomic, vault } from "./storage"
import type { HostTools } from "./host"
export { hostTools } from "./host"
import type { RunnerTool } from "./extensions"
import { builtinExtensions } from "./builtins"
import { processesExtension } from "./processes"
import { Configuration } from "./configuration"
import { ExtensionManager } from "./extension-manager"
import { Packages } from "./packages"
import { packageTools } from "./package-tools"
import { capabilityConfiguration, summaryPrompt } from "./capabilities"
import { presetInventory } from "./preset-mcp"
import type { Nexus } from "@opencode/schema/nexus"
import { executionConfiguration } from "./execution-settings"
import type { BuiltinPolicy } from "./runner-inbox"
import { Checkpoints } from "./checkpoints"
export type { NexusExtension, RunnerTool, RunnerContext } from "./extensions"
export type {
  ExtensionModule,
  ExtensionAPI,
  ToolCall,
  ToolDecision,
  ToolResult,
  ExtensionAgent,
  ExtensionCommand,
  ConversationServers,
} from "./extension-manager"
export type { ExtensionDescriptor } from "./configuration"
import { ClaimJournal } from "./claims"
import { webSite } from "./web"
import type { ApprovalGrant } from "./approval-grant"
import { HumanLogin } from "./login"
import { NexusApplication } from "./application"
import { Operations } from "./operations"
import { conversationMemory } from "./memory-commands"
export { NexusApplication } from "./application"
import type { NexusPreset } from "@opencode/schema/nexus-preset"
import type { NexusBot } from "@opencode/schema/nexus-bot"
import { operatorTools, RunnerAdmission, tools, readEffect } from "./runner"
import { NexusExecutor } from "./executor"
import { EnvironmentChange } from "./environments"
import { DefaultEnvironment } from "./default-environment"
import type { NexusRun } from "@opencode/schema/nexus-run"
import { ApplicationSettings, readConnectionSettings, type Settings } from "./settings"
import { Adaptations } from "./adaptations"
import { AgentRenewal, renewalClock } from "./renewal"
import { McpSessions, McpUnavailable } from "./mcp-sessions"
import { isSubagentTool } from "./bot-policy"

const ModeValues = Schema.Struct({ code_mode: Schema.Boolean, subagent: Schema.Boolean })

type Identity = { agent: string; name: string; runner: string; workspace: string; workspaceName: string }
type Pairing = { code: string; url: string }
type Connection = {
  profileDigest?: string
  profileWrites: Promise<void>
  configuration: AgentConfigurationInput
  member: Client
  candidates: ReadonlySet<string>
  identity: Identity
  application: NexusApplication
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
  executor?: Nexus.ExecutorStatus
}

/** One owner, scoped to the elected OpenCode service. Browser and CLI clients share this instance. */
export class NexusRuntime {
  private stop = new AbortController()
  private readonly human: HumanLogin
  private readonly store: CredentialStore
  private readonly defaultEnvironment: DefaultEnvironment
  private renewal?: AgentRenewal
  private work?: Promise<void>
  private pending?: Promise<Status>
  private settings?: Settings
  private connection?: Connection
  private readonly sites = new Set<string>()
  private readonly approvals: ApprovalGrant[] = []
  private declaring = Promise.resolve()
  private credentials?: OAuthCredentials | APIKeyCredentials
  private readonly applicationSettings: ApplicationSettings
  private adaptations?: Adaptations
  private extensionManager?: ExtensionManager
  private packages?: Packages
  private readonly editorSessions = new McpSessions(
    () => this.extensionTools(),
    async (input) => {
      const registrar = this.extensionManager?.conversationServers()
      if (!registrar) throw new McpUnavailable("mcp_unavailable: no conversation MCP registrar is loaded.")
      const opened = await registrar(input)
      if (registrar !== this.extensionManager?.conversationServers()) {
        await opened.close()
        throw new McpUnavailable("mcp_unavailable: the conversation MCP registrar changed while opening its servers.")
      }
      return opened
    },
    () => this.publish?.() ?? Promise.resolve(),
    () => !!this.extensionManager?.conversationServers(),
  )
  private editorChanges = Promise.resolve()
  private publish?: () => Promise<void>
  private executor?: NexusExecutor
  private statusValue: Status = { state: "unpaired", origin: "", model: "", directory: "", workspace: "" }

  constructor(
    private readonly storage: string,
    private readonly host?: HostTools,
    private readonly clock = renewalClock,
  ) {
    this.applicationSettings = new ApplicationSettings(join(storage, "application-settings.json"))
    this.human = new HumanLogin(join(storage, "human"))
    this.store = vault(join(storage, "agent.json"))
    this.defaultEnvironment = new DefaultEnvironment(join(storage, "environment.json"), [storage])
  }

  status() {
    return {
      ...this.statusValue,
      ...(this.renewal?.issue && { error: this.renewal.issue }),
      ...(this.executor && { executor: this.executor.snapshot() }),
    }
  }

  async *runPrompt(input: NexusRun.Input, signal: AbortSignal) {
    if (!this.connection) {
      yield {
        type: "result",
        subtype: "failed",
        is_error: true,
        exit_status: 1,
        status: "failed",
        reason: "Nexus is disconnected.",
        result: null,
      }
      return
    }
    const { runPrompt } = await import("./run")
    yield* runPrompt(this.connection.application, input, signal)
  }

  private codeModeEnabled() {
    return (
      this.extensionManager?.list().some((extension) => extension.id === "nexus.codemode" && extension.active) ?? false
    )
  }

  private readonly summarizer = (policy: AgentConfigurationInput["compaction_policy"]) =>
    summaryPrompt(policy, (model) => this.adaptations?.summarizer(model))

  private declareProfile(
    active: Connection,
    options?: RequestOptions,
    rules?: AgentConfigurationInput["approval_rules"],
  ) {
    const publish = active.profileWrites.then(async () => {
      const snapshot = await active.application.presets.snapshot()
      const selected = await active.application.presets.resolve(active.configuration, undefined, undefined, snapshot)
      const declaration = {
        configuration: {
          ...selected.configuration,
          approval_rules: [...(selected.configuration.approval_rules ?? []), ...(rules ?? this.siteRules())],
        },
        prompt_documents: {
          system_prompt: { content: selected.instructions },
          summarizer: selected.summarizer === null ? null : { content: selected.summarizer },
        },
      }
      const digest = createHash("sha256").update(JSON.stringify(declaration)).digest("hex")
      if (active.profileDigest !== digest) {
        await active.member.profile.declareConfiguration(declaration, options)
        active.profileDigest = digest
      }
      return snapshot
    })
    active.profileWrites = publish.then(
      () => {},
      () => {},
    )
    return publish
  }

  conversationDefaults() {
    const extension = this.extensionManager?.list().find((extension) => extension.id === "nexus.codemode")
    return {
      code_mode: this.codeModeEnabled() && extension?.configuration.default !== "off",
      subagent: this.applicationSettings.read().subagent_default,
    }
  }

  private async importKeys(input: {
    origin: string
    model: string
    workspace: string
    directory: string
    access_token: string
    executor_access_token: string
  }) {
    if (this.pending || this.statusValue.state === "pairing" || this.statusValue.state === "connecting")
      throw new Error("A connection is already in progress.")
    if (this.executor?.snapshot().in_flight) throw new Error("Wait for running tools before replacing the connection.")
    const url = new URL(input.origin)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Enter a Nexus origin.")
    if (!isAbsolute(input.directory)) throw new Error("Select an absolute runner directory.")
    const directory = await realpath(input.directory)
    if (!(await stat(directory)).isDirectory() || !input.model.trim()) throw new Error("Select a directory and model.")
    const relativePath = relative(directory, this.storage)
    const inverse = relative(this.storage, directory)
    if ([relativePath, inverse].some((value) => !isAbsolute(value) && value !== ".." && !value.startsWith(".." + sep)))
      throw new Error("Choose a project directory outside the credential store.")
    const document = decodeCredentialDocument({
      version: 2,
      authentication_kind: "api_key",
      connection: crypto.randomUUID(),
      access_token: input.access_token.trim(),
      executor_access_token: input.executor_access_token.trim(),
    })
    if (document.authentication_kind !== "api_key") throw new Error("Expected API keys.")
    const credentials = new APIKeyCredentials(document)
    const member = new Client({ baseURL: url.origin, credentialProvider: credentials.provider("member") })
    const executor = new ExecutorClient({
      baseURL: url.origin,
      credentialProvider: async () => credentials.provider("executor")(),
    })
    const [profile, address] = await Promise.all([member.profile.fetch(), executor.executor()])
    if (profile.member.kind !== "agent" || address.executor.agent_public_id !== profile.member.public_id)
      throw new Error("Keys must identify the same Agent application address.")
    if (input.workspace) await member.workspaces.fetch(input.workspace)
    await this.close()
    this.stop = new AbortController()
    this.connection = undefined
    this.settings = {
      origin: url.origin,
      directory,
      model: input.model.trim(),
      workspace: input.workspace,
      identifier: "opencode." + crypto.randomUUID(),
    }
    await mkdir(this.storage, { recursive: true, mode: 0o700 })
    await this.store.write(document)
    await atomic(join(this.storage, "settings.json"), this.settings)
    this.start(credentials, this.settings)
    return this.status()
  }

  async restore() {
    const settings = await readConnectionSettings(this.storage)
    if (!settings) return
    this.settings = settings
    this.statusValue = this.view("unpaired")
    const authority = new DeviceFlow({ baseURL: this.settings.origin })
    const saved = await this.store.read()
    const document = saved ? decodeCredentialDocument(saved) : null
    const credentials =
      document?.authentication_kind === "api_key"
        ? new APIKeyCredentials(document)
        : await OAuthCredentials.load({ authority, store: this.store, clock: this.clock.now })
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
        const credentials = await OAuthCredentials.issue({
          credentials: bundle,
          authority,
          store: this.store,
          clock: this.clock.now,
        })
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
      model: this.applicationSettings.read().default_model ?? settings?.model ?? "",
      workspace: settings?.workspace ?? "",
      directory: this.defaultEnvironment.current ?? settings?.directory ?? "",
    }
  }

  private failed(cause: unknown) {
    if (!this.stop.signal.aborted)
      this.statusValue = {
        ...this.view("error"),
        error: cause instanceof Error ? cause.message : "Nexus connection failed.",
      }
  }

  private start(credentials: OAuthCredentials | APIKeyCredentials, settings: Settings) {
    this.credentials = credentials
    this.work = this.run(credentials, settings, this.stop.signal)
      .catch((cause) => this.failed(cause))
      .finally(() => {
        this.work = undefined
      })
  }

  private async run(credentials: OAuthCredentials | APIKeyCredentials, settings: Settings, signal: AbortSignal) {
    if (!(credentials instanceof OAuthCredentials)) return this.serve(credentials, settings, signal)
    const renewal = new AgentRenewal(credentials, this.clock)
    this.renewal = renewal
    const owner = new AbortController()
    const active = AbortSignal.any([signal, owner.signal, renewal.lost.signal])
    const maintenance = renewal.maintain(active).catch((error) => {
      if (!active.aborted) throw error
    })
    try {
      await this.serve(credentials, settings, active, renewal)
    } catch (error) {
      if (!renewal.lost.signal.aborted) throw error
    } finally {
      owner.abort()
      await maintenance
      await credentials.drain()
      this.renewal = undefined
      if (renewal.lost.signal.aborted && !signal.aborted) {
        const loss: unknown = renewal.lost.signal.reason
        await this.releaseConnection()
        // The SDK checks the stored lineage before deleting a credential it has marked lost.
        if (loss instanceof AuthorizationLost)
          await credentials.revoke().catch((error: unknown) => {
            if (!(error instanceof ConnectionSuperseded)) throw error
          })
        this.credentials = undefined
        this.statusValue = {
          ...this.view("unpaired"),
          error: "Agent authorization was lost. Pair this installation again.",
        }
      }
    }
  }

  private async serve(
    credentials: OAuthCredentials | APIKeyCredentials,
    settings: Settings,
    signal: AbortSignal,
    renewal?: AgentRenewal,
  ) {
    this.statusValue = this.view("connecting")
    await this.applicationSettings.restore()
    this.adaptations = await Adaptations.load(
      this.applicationSettings.read(),
      this.storage,
      this.applicationSettings.read().default_model ?? settings.model,
    )
    await this.defaultEnvironment.restore(settings.directory)
    this.statusValue = this.view("connecting")
    const memberOptions = renewal?.options(settings.origin, "member") ?? {
      baseURL: settings.origin,
      credentialProvider: credentials.provider("member"),
    }
    const member = new Client(memberOptions)
    const options = renewal?.options(settings.origin, "executor") ?? {
      baseURL: settings.origin,
      credentialProvider: async () => credentials.provider("executor")(),
    }
    const socket = (options: ConstructorParameters<typeof RealtimeClient>[0]) =>
      renewal?.socket(options) ?? new RealtimeClient(options)
    const executor = new ExecutorClient(options)
    const refresh = (role: "agent" | "runner" = "runner") => {
      const policy = executionConfiguration(this.extensionManager?.list() ?? [])
      return [
        ...(role === "runner"
          ? tools.filter(
              (tool) =>
                (this.host || !["bash", "find", "grep"].includes(tool.name)) &&
                (tool.name === "code" ? this.codeModeEnabled() : policy.coding),
            )
          : []),
        ...this.runtimeTools()
          .filter((tool) => (tool.role ?? "runner") === role)
          .map((tool) => tool.definition),
      ]
    }
    const operators = () => {
      const policy = executionConfiguration(this.extensionManager?.list() ?? [])
      return operatorTools.filter((tool) =>
        ["checkpoints", "checkpoint_restore"].includes(tool.name) ? !!policy.checkpoints : policy.coding,
      )
    }
    const builtins = (): BuiltinPolicy => {
      const policy = executionConfiguration(this.extensionManager?.list() ?? [])
      return {
        tools: [...refresh(), ...operators()],
        bashTimeoutSeconds: policy.bashTimeoutSeconds,
        checkpoints: policy.checkpoints
          ? new Checkpoints(
              join(this.storage, "checkpoints", settings.identifier),
              this.defaultEnvironment.root,
              policy.checkpoints,
            )
          : undefined,
      }
    }
    const applicationTools = () =>
      this.extensionTools()
        .filter((tool) => tool.role === "agent")
        .map((entry) => entry.definition)
        .map((tool) => ({
          type: "function" as const,
          function: { name: tool.name, description: tool.description ?? undefined, parameters: tool.input_schema },
          ...(tool.effect_profile ? { effect_profile: { ...tool.effect_profile } } : {}),
        }))
    const registered = new RegisteredAgents(member)
    const configuration = new Configuration(join(this.storage, "configuration.json"))
    await configuration.restore()
    this.packages = new Packages(this.storage, configuration, this.host)
    const documents = (role: "agent" | "runner") =>
      (this.extensionManager?.documents() ?? [])
        .filter((document) => document.role === role)
        .map((document) => ({ name: document.name, description: document.description }))
    const environment = async () => {
      const value = await runnerEnvironment(this.defaultEnvironment.root)
      const description = await this.extensionManager?.describeEnvironment(value)
      return { ...value, report: [value.report, description].filter(Boolean).join("\n\n") }
    }
    const processes = processesExtension(this.storage)
    this.extensionManager = new ExtensionManager(
      configuration,
      [
        ...(await builtinExtensions(this.host, this.storage, processes)),
        packageTools(this.packages, () => this.extensionManager!),
        ...(await this.packages.sources()),
      ],
      this.defaultEnvironment.root,
      signal,
      (this.publish = async () => {
        if (!this.extensionManager?.conversationServers()) await this.editorSessions.close()
        await executor.announce(
          {
            services: {
              agent: { tools: refresh("agent"), documents: documents("agent") },
              runner: {
                tools: [...refresh(), ...operators()],
                documents: documents("runner"),
                environment: await environment(),
              },
            },
          },
          { signal },
        )

        await builtins().checkpoints?.prune()

        const active = this.connection

        if (!active) return

        const catalog = await member.tools.list({ signal })
        const available = new Set(catalog.map((tool) => tool.canonical_name))
        const capabilities = capabilityConfiguration(
          this.extensionManager?.list() ?? [],
          this.applicationSettings.read().kernel_tools.filter((name) => available.has(name)),
        )
        const adapted = this.adaptations!.configuration(capabilities.kernel_tools, catalog)

        active.configuration = {
          ...active.configuration,
          ...capabilities,
          kernel_tools: adapted.kernel_tools,
          default_model: this.applicationSettings.read().default_model ?? settings.model,
          fallback_models: [...this.applicationSettings.read().fallback_models],
          runner_tool_names: refresh()
            .filter((tool) => !tool.mcp)
            .map((tool) => tool.name),
          tool_definitions: [...applicationTools(), ...adapted.tool_definitions],
        }
        await this.declareProfile(active, { signal })
        await registered.sync(this.extensionManager?.agents() ?? [], active.configuration, this.summarizer)
      }),
      () => {
        if (!this.connection) throw new Error("Nexus is disconnected.")

        return this.connection.application
      },
      (role) => (role === "runner" ? [...tools, ...operatorTools] : []),
    )
    await this.extensionManager.start()

    const names = [...refresh(), ...operators()].map((tool) => tool.name)
    if (new Set(names).size !== names.length) throw new Error("Nexus extensions must provide unique tool names.")
    await builtins().checkpoints?.prune()
    const journal = new ClaimJournal(join(this.storage, "claims", settings.identifier))
    const admission = new RunnerAdmission()
    while (!signal.aborted) {
      try {
        const availableTools = refresh()
        const announced = await executor.announce(
          {
            services: {
              agent: { tools: refresh("agent"), documents: documents("agent") },
              runner: {
                tools: [...availableTools, ...operators()],
                documents: documents("runner"),
                environment: await environment(),
              },
            },
          },
          { signal },
        )
        const runner = announced.executor.public_id
        settings = this.settings ?? settings
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
        const catalog = await member.tools.list({ signal })
        const available = new Set(catalog.map((tool) => tool.canonical_name))
        const kernel = this.applicationSettings.read().kernel_tools.filter((name) => available.has(name))
        const capabilities = capabilityConfiguration(this.extensionManager?.list() ?? [], kernel)
        const adapted = this.adaptations!.configuration(capabilities.kernel_tools, catalog)
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
          tool_definitions: [...applicationTools(), ...adapted.tool_definitions],
          default_model: this.applicationSettings.read().default_model ?? settings.model,
          fallback_models: [...this.applicationSettings.read().fallback_models],
          approval_mode: "ask",
          prompt_mechanism: "default",
          ...capabilities,
          kernel_tools: adapted.kernel_tools,
          runner_executor_public_ids: [...new Set([runner, ...candidates.map((row) => row.public_id)])],
          runner_tool_names: availableTools.filter((tool) => !tool.mcp).map((tool) => tool.name),
        }
        const profile = await member.profile.fetch({ signal })
        const identity = {
          agent: profile.member.public_id,
          name: profile.member.display_name ?? profile.member.handle,
          runner,
          workspace: workspace.public_id,
          workspaceName: workspace.name,
        }
        const admissionScope = createHash("sha256")
          .update(JSON.stringify([settings.origin, identity.agent]))
          .digest("hex")
        const active: Connection = {
          profileWrites: Promise.resolve(),
          member,
          configuration,
          candidates: new Set([runner, ...candidates.map((row) => row.public_id)]),
          identity,
          application: new NexusApplication(
            member,
            identity,
            () => active.configuration,
            () => ({ [identity.runner]: { "opencode.directory": this.defaultEnvironment.root } }),
            (workspace, conversation, preset) => this.policy(workspace, conversation, preset),
            (name, value) => this.extensionManager?.emit(name, value) ?? Promise.resolve(),
            () =>
              presetInventory(
                member,
                identity,
                this.extensionTools()
                  .filter((tool) => tool.role === "agent")
                  .map((tool) => tool.definition),
                active.configuration,
              ),
            {
              agents: () => this.extensionManager?.agents().map((agent) => agent.name) ?? [],
              author: (draft) => this.extensionManager?.author(draft) ?? Promise.resolve(draft),
              follow: (value) => this.extensionManager?.follow(value) ?? Promise.resolve(undefined),
              bindings: (value) => this.extensionManager?.bindings(value) ?? Promise.resolve([]),
              describeEnvironment: (value) => this.extensionManager?.describeEnvironment(value) ?? Promise.resolve(""),
            },
            { grant: (value) => this.grantRule(value), list: () => this.approvals },
            () =>
              socket({
                ...memberOptions,
                timeoutMs: 5000,
              }),
            () => ({
              ...this.conversationDefaults(),
              title_model: this.applicationSettings.read().conversation_title_model,
              bash_timeout_seconds: executionConfiguration(this.extensionManager?.list() ?? []).bashTimeoutSeconds,
              hints: (model) => this.adaptations?.hints(model) ?? "",
              adaptations: (model) => this.adaptations?.facts(model) ?? {},
              summarizer: this.summarizer,
            }),
            join(this.storage, "admissions", admissionScope),
          ),
        }
        await this.declareProfile(active, { signal })
        this.connection = active
        active.application.environments.configure({
          root: () => this.defaultEnvironment.root,
          documents: () => documents("runner"),
          liveProcess: processes.liveIn,
          checkpoints: () => builtins().checkpoints,
          protectedRoots: [this.storage],
          hosts: () => this.connection?.application.lifecycle.hostsSnapshot() ?? [],
          mcp: (workspace, conversation, cwd, servers) =>
            this.editorMcp("editor.mcp.attach", { workspace, conversation, cwd, servers }),
        })
        this.connection.application.runners.configure({
          storage: join(this.storage, "runner.json"),
          hosts: () => this.connection?.application.lifecycle.hostsSnapshot() ?? [],
          refresh: async (ids) => {
            const active = this.connection
            if (!active) return
            active.candidates = new Set([active.identity.runner, ...ids])
            active.configuration = { ...active.configuration, runner_executor_public_ids: [...active.candidates] }
            await this.declareProfile(active)
          },
        })
        await registered.sync(this.extensionManager?.agents() ?? [], configuration, this.summarizer)
        this.statusValue = { ...this.view("ready"), identity }
        await this.extensionManager?.emit("member.connected", identity)
        const ingress = new AbortController()
        const following = this.connection.application.until.watch(
          [identity.agent],
          AbortSignal.any([signal, ingress.signal]),
        )
        const lifecycle = this.connection.application.watch(AbortSignal.any([signal, ingress.signal]))
        const inbox = this.listen(
          socket(options),
          executor,
          runner,
          this.defaultEnvironment.root,
          journal,
          AbortSignal.any([signal, ingress.signal]),
          builtins,
          () => this.runtimeTools(),
          admission,
        )
        try {
          await Promise.race([inbox, following, lifecycle])
        } finally {
          ingress.abort()
          await Promise.allSettled([inbox, following, lifecycle])
        }
      } catch (cause) {
        // Registration can fail after the application accepts commands and before its watchers start.
        await this.connection?.application.inference.close()
        await this.extensionManager?.emit("member.disconnected", {})
        this.connection = undefined
        this.failed(cause)
        if (signal.aborted || (!renewal && cause instanceof APIError && cause.status === 401)) return
        await scheduler.wait(5000, { signal })
      }
    }
  }

  private extensionTools(): RunnerTool[] {
    const manager = this.extensionManager
    if (!manager) return []
    return [
      ...manager.tools(),
      ...(["agent", "runner"] as const).flatMap((role): RunnerTool[] =>
        manager.documents().some((document) => document.role === role)
          ? [
              {
                role,
                definition: {
                  name: "skill",
                  description: "Load a skill document by its announced name.",
                  effect_profile: readEffect,
                  input_schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    additionalProperties: false,
                  },
                },
                async execute(input, context) {
                  const value = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(input)
                  if (!manager.documents().some((document) => document.name === value.name && document.role === role))
                    return { is_error: true, content: "skill_unknown: " + value.name }
                  return manager.readDocument(value.name, context, role)
                },
              },
            ]
          : [],
      ),
    ]
  }

  private runtimeTools() {
    return [...this.extensionTools(), ...this.editorSessions.tools()]
  }

  private editorMcp(action: string, input: Schema.Json) {
    const command = Schema.decodeUnknownSync(
      Schema.Struct({
        workspace: Schema.String,
        conversation: Schema.String,
        cwd: Schema.optional(Schema.String),
        servers: Schema.optional(Schema.Json),
      }),
    )(input)
    const operation = this.editorChanges.then(async () => {
      const active = this.connection
      if (!active) throw new Error("Editor MCP requires a connected OpenCode runtime.")
      const servers = action === "editor.mcp.detach" ? [] : (command.servers ?? [])
      // Host deletion may already make the conversation unreadable; clearing owns no new authority.
      if (Array.isArray(servers) && !servers.length)
        return this.editorSessions.bind({ ...command, directory: command.cwd ?? "", servers, signal: this.stop.signal })
      const info = await active.member.workspace(command.workspace).conversation(command.conversation).fetch()
      if (
        info.side
          ? !(await active.application.sides.read(command.workspace, command.conversation))
          : info.answering_user_public_id !== active.identity.agent &&
            info.default_runner?.executor_public_id !== active.identity.runner
      )
        throw new Error("Unknown editor conversation.")
      if (info.archived_at || !command.cwd || !isAbsolute(command.cwd))
        throw new Error("Editor MCP requires an active conversation and absolute working directory.")
      const directory =
        info.default_runner?.executor_public_id === active.identity.runner ? command.cwd : this.defaultEnvironment.root

      return this.editorSessions.bind({ ...command, directory, servers, signal: this.stop.signal })
    })
    this.editorChanges = operation.then(
      () => {},
      () => {},
    )
    return operation
  }

  private async listen(
    realtime: RealtimeClient,
    executor: ExecutorClient,
    id: string,
    directory: string,
    journal: ClaimJournal,
    signal: AbortSignal,
    builtins: () => BuiltinPolicy,
    extensions: () => readonly RunnerTool[],
    admission: RunnerAdmission,
  ) {
    const inbox = new NexusExecutor({
      executor,
      id,
      root: directory,
      storage: this.storage,
      journal,
      signal,
      extensions,
      admission,
      host: this.host,
      builtins,
      protectedRoots: [this.storage],
      realtime,
      fatalUnauthorized: !this.renewal,
      ports: {
        read: (workspace, anchor) => this.connection?.application.environments.port(workspace, anchor),
        drop: (workspace, anchor, port) => this.connection?.application.environments.dropPort(workspace, anchor, port),
      },
      hooks: () => this.extensionManager!.captureTools(),
    })
    this.executor = inbox
    try {
      await inbox.start()
    } finally {
      await inbox.close()
    }
  }

  runners() {
    if (!this.connection) throw new Error("Nexus is disconnected.")
    return this.connection.application.runners
      .list()
      .then((result) => result.runners.map((row) => ({ id: row.public_id, name: row.display_name || row.public_id })))
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
    if (!active) throw new Error("The selected workspace is unavailable.")
    const chat = active.member.workspace(workspace).conversation(conversation)
    const info = await chat.fetch()
    if (info.answering_user_public_id !== active.identity.agent) {
      if (patch) throw new Error("These conversation settings are unavailable.")
      return { code_mode: false, subagent: false, available: false, code_mode_available: false }
    }
    if ((info.side && !(await active.application.sides.read(workspace, conversation))) || (patch && info.archived_at))
      throw new Error("These conversation settings are unavailable.")
    let after: string | undefined
    do {
      const page = await chat.storeEntries.list({ after })
      const entry = page.items.find((row) => row.namespace === "opencode" && row.key === "modes")
      if (entry) {
        const saved = await chat.storeEntries.fetch(entry.public_id)
        const modes = Schema.decodeUnknownSync(ModeValues)(saved.value)
        if (!patch) return { ...modes, available: true, code_mode_available: this.codeModeEnabled() }
        const next = { ...modes, ...patch }
        await chat.storeEntries.update(saved.public_id, { value: next, lock_version: saved.lock_version })
        return { ...next, available: true, code_mode_available: this.codeModeEnabled() }
      }
      after = page.next_after ?? undefined
    } while (after)
    const defaults = { code_mode: true, subagent: true, ...patch }
    if (patch)
      await chat.storeEntries.create(
        { namespace: "opencode", key: "modes", value: defaults },
        { idempotencyKey: crypto.randomUUID() },
      )
    return { ...defaults, available: true, code_mode_available: this.codeModeEnabled() }
  }

  async policy(workspace: string, conversation: string, preset?: string, model?: string, capturedChat?: Conversation) {
    const active = this.connection
    if (!active || !this.settings) throw new Error("The selected workspace is unavailable.")
    const chat = capturedChat ?? (await active.member.workspace(workspace).conversation(conversation).fetch())
    if (
      chat.answering_user_public_id !== active.identity.agent ||
      (chat.side && !(await active.application.sides.read(workspace, conversation))) ||
      chat.archived_at
    )
      throw new Error("This conversation cannot receive input here.")
    const runner = chat.default_runner?.executor_public_id
    const modes = await this.modes(workspace, conversation)
    const snapshot = await this.declareProfile(active, { signal: this.stop.signal })
    const captured = await active.application.prepare(preset, { workspace, conversation }, snapshot)
    const context = await active.application.environments.capture(
      workspace,
      conversation,
      runner ?? active.identity.runner,
    )
    const environment = Schema.decodeUnknownSync(
      Schema.Struct({ root: Schema.String, anchor: Schema.NullOr(Schema.String) }),
    )(context["opencode.environment"])
    const editor = environment.anchor
      ? this.editorSessions.get(JSON.stringify([workspace, environment.anchor]))
      : undefined
    const agent_configuration: JsonObject = {
      ...captured.agent_configuration,
      ...(editor
        ? {
            tool_definitions: [
              ...Schema.decodeUnknownSync(Schema.mutable(Schema.Array(Schema.MutableJson)))(
                captured.agent_configuration.tool_definitions ?? [],
              ),
              ...editor.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.definition.name,
                  description: tool.definition.description ?? "",
                  parameters: tool.definition.input_schema ?? { type: "object" },
                },
                effect_profile: { ...tool.definition.effect_profile },
              })),
            ],
          }
        : {}),
    }
    const prepared = {
      ...captured,
      agent_configuration,
      instructions: this.adaptations?.hints(model ?? captured.model),
    }
    const assembly = await active.member.tools.assemble({
      default_runner_executor_public_id: runner ?? null,
      ...(capturedChat?.agent_configuration_present
        ? { conversation_public_id: conversation }
        : { configuration: prepared.agent_configuration }),
    })
    const selected = assembly.tool_definitions.flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return []
      const fn = row.function
      if (!fn || typeof fn !== "object" || Array.isArray(fn) || typeof fn.name !== "string") return []
      if (
        (!modes.code_mode || !this.codeModeEnabled()) &&
        !(
          typeof row.route === "object" &&
          row.route !== null &&
          !Array.isArray(row.route) &&
          row.route.kind === "mcp"
        ) &&
        ((typeof row.route === "object" && row.route !== null && !Array.isArray(row.route)
          ? row.route.tool_name
          : undefined) ??
          row.canonical ??
          fn.name) === "code"
      )
        return []
      if (!modes.subagent && isSubagentTool(fn.name, row.canonical, row.route)) return []
      return [fn.name]
    })
    const executor_contexts: Record<string, JsonObject> = {
      [active.identity.runner]: { "opencode.mcp": { anchor: environment.anchor } },
      ...(runner ? { [runner]: context } : {}),
    }
    if (!runner) return { ...prepared, tools: selected, directory: null, runner: null, executor_contexts }
    if (
      runner !== active.identity.runner &&
      !(await active.member.executors.fetch(runner)).service_roles.includes("runner")
    )
      throw new Error("The selected runner is unavailable.")
    return {
      ...prepared,
      tools: selected,
      directory: environment.root,
      runner,
      executor_contexts,
    }
  }

  async operator(input: typeof NexusOperator.Type) {
    const active = this.connection
    if (!active) throw new Error("Unknown paired workspace.")
    const workspace = active.member.workspace(input.workspace)
    const chat = await workspace.conversation(input.conversation).fetch()
    if (chat.side || chat.answering_user_public_id !== active.identity.agent || !active.candidates.has(input.runner))
      throw new Error("Unknown conversation or runner.")
    const operation = input.operation
    const args = await (async (): Promise<JsonObject> => {
      if (operation.tool === "files_bytes") {
        if (chat.default_runner?.executor_public_id !== input.runner) throw new Error("The runner binding changed.")
        const environment = await active.application.environments.read(
          input.workspace,
          input.conversation,
          input.runner,
        )
        const root = environment.root
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
    if (command.action === "application.defaults")
      return { ...this.conversationDefaults(), available: true, code_mode_available: this.codeModeEnabled() }
    if (command.action === "settings.read") {
      await this.applicationSettings.restore()
      return this.applicationSettings.read()
    }
    if (command.action === "settings.update") {
      await this.applicationSettings.restore()
      const value = await this.applicationSettings.change(command.patch, async (settings) => {
        const candidate = await Adaptations.load(settings, this.storage, settings.default_model ?? this.settings?.model)
        if (this.connection)
          candidate.configuration([...settings.kernel_tools], await this.connection.member.tools.list())
      })
      this.adaptations = await Adaptations.load(value, this.storage, value.default_model ?? this.settings?.model)
      await this.publish?.()
      this.statusValue = { ...this.statusValue, model: value.default_model ?? this.settings?.model ?? "" }
      return value
    }
    if (command.action === "connection.import") return this.importKeys(command)
    if (command.action === "extension.list") return this.extensions()
    if (command.action === "extension.asset") {
      if (!this.extensionManager) throw new Error("Nexus extensions are not loaded.")
      return this.extensionManager.asset(command.id, command.version, command.path)
    }
    if (command.action === "login.device") {
      if (!this.settings) throw new Error("Configure a Nexus origin first.")
      return this.human.device(this.settings.origin, this.settings.identifier)
    }
    if (command.action === "platform.request") {
      if (!this.settings) throw new Error("Configure a Nexus origin first.")
      return this.human.request(this.settings.origin, command)
    }
    if (command.action === "extension.configure") return this.configureExtension(command.change)
    if (command.action === "extension.call") {
      if (command.name === "application.upload") {
        if (!this.connection) throw new Error("Nexus is disconnected.")
        return this.connection.application.operations.command({
          action: "upload",
          ...Schema.decodeUnknownSync(
            Schema.Struct({ name: Schema.String, mime: Schema.String, content: Schema.String }),
          )(command.input),
        })
      }
      if (command.name === "editor.auth.credential")
        return this.settings ? this.human.memberCredential(this.settings.origin) : null
      if (command.name === "editor.auth.start") {
        if (this.statusValue.state === "ready") return { url: await this.login() }
        if (this.statusValue.pairing) return this.statusValue.pairing
        if (!this.settings) throw new Error("Configure Nexus with --url and --model before authenticating.")
        if (this.statusValue.state === "error") throw new Error(this.statusValue.error ?? "Nexus could not connect.")
        if (this.statusValue.state === "unpaired") await this.pair(this.settings)
        if (this.statusValue.pairing) return this.statusValue.pairing
        throw new Error("Nexus is still connecting. Authenticate again when startup completes.")
      }
      if (!this.extensionManager) throw new Error("Nexus extensions are not loaded.")
      if (command.name === "env") {
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            root: Schema.optional(Schema.NullOr(Schema.String)),
            clear: Schema.optional(Schema.Boolean),
          }),
        )(command.input)
        if (value.root !== undefined || value.clear) {
          await this.defaultEnvironment
            .change(value.clear ? null : value.root!, async (root, persist) => {
              await this.extensionManager!.setDirectory(root, async () => {
                await this.publish?.()
                await persist()
              })
              this.executor?.setRoot(root)
              this.statusValue = { ...this.statusValue, directory: root }
            })
            .catch(async (error: unknown) => {
              await this.publish?.().catch(() => {})
              throw error
            })
        }
        return { ...(await runnerEnvironment(this.defaultEnvironment.root)), source: this.defaultEnvironment.source }
      }
      if (command.name === "packages") {
        if (!this.packages) throw new Error("Nexus packages are not loaded.")
        return this.packages.command(command.input, this.extensionManager, this.stop.signal)
      }

      if (command.name === "editor.mcp.attach" || command.name === "editor.mcp.detach")
        return this.editorMcp(command.name, command.input).catch((error: unknown) => {
          if (error instanceof McpUnavailable) return { tools: [], issues: [error.message] }
          throw error
        })
      if (["environment.read", "environment.bind", "editor.environment.bind", "environments"].includes(command.name)) {
        const active = this.connection
        if (!active) throw new Error("Nexus is disconnected.")
        if (command.name === "environments") return active.application.environments.list()
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            workspace: Schema.optional(Schema.String),
            conversation: Schema.String,
            runner: Schema.optional(Schema.String),
            ...EnvironmentChange.fields,
          }),
        )(command.input)
        const workspace = value.workspace ?? active.identity.workspace
        return command.name === "environment.read"
          ? active.application.environments.read(workspace, value.conversation, value.runner)
          : active.application.environments.bind(workspace, value.conversation, value, value.runner)
      }
      if (["runners", "runners.use", "set_default_runner"].includes(command.name)) {
        const active = this.connection
        if (!active) throw new Error("Nexus is disconnected.")
        if (command.name === "runners") return active.application.runners.list()
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            runner: Schema.NullOr(Schema.String),
            host: Schema.optional(Schema.String),
            workspace: Schema.optional(Schema.String),
            kind: Schema.optional(Schema.Literals(["conversation", "run"])),
          }),
        )(command.input)
        if (command.name === "runners.use") return active.application.runners.select(value.runner)
        if (!value.host) throw new Error("set_default_runner requires a host")
        return active.application.runners.set(
          value.workspace ?? active.identity.workspace,
          value.host,
          value.runner,
          value.kind,
        )
      }
      return this.extensionManager.command(command.name, command.input)
    }

    if (command.action.startsWith("acp.")) {
      if (!this.extensionManager) throw new Error("ACP delegation is not loaded.")
      return this.extensionManager.command(
        command.action,
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(command)),
      )
    }

    const active = this.connection
    if (!active || !this.settings) throw new Error("Nexus is disconnected.")
    if (
      command.action === "inference.create" ||
      command.action === "inference.list" ||
      command.action === "inference.subscribe" ||
      command.action === "inference.unsubscribe"
    ) {
      if (token) throw new Error("Inference management uses the paired Agent credential.")
      return active.application.inference.command(command.workspace ?? active.identity.workspace, command)
    }
    if (command.action === "workspace.list")
      return { items: await active.application.workspaces.list(), selected: active.identity.workspace }
    if (command.action === "workspace.create")
      return active.member.workspaces.create(
        { name: command.name, access_mode: "private" },
        { idempotencyKey: command.key },
      )
    if (command.action === "workspace.use") {
      const workspace = await active.application.workspaces.require(command.workspace)
      await atomic(join(this.storage, "settings.json"), { ...this.settings, workspace: workspace.public_id })
      this.settings = { ...this.settings, workspace: workspace.public_id }
      active.identity.workspace = workspace.public_id
      active.identity.workspaceName = workspace.name
      this.statusValue = { ...this.statusValue, workspace: workspace.public_id, identity: { ...active.identity } }
      return workspace
    }
    if (command.action.startsWith("preset.")) {
      const result = await active.application.presets.command(command as NexusPreset.Command)
      if (
        !["preset.tools", "preset.read", "preset.list", "preset.export", "preset.export-document"].includes(
          command.action,
        )
      )
        await this.declareProfile(active, { signal: this.stop.signal })
      return result
    }
    if (command.action.startsWith("bot.") && command.action !== "bot.submit")
      return active.application.bots.command(command as NexusBot.Command)
    if (command.action === "persona.read" || command.action === "persona.write" || command.action === "persona.reset") {
      const platform = await this.human.platform(this.settings.origin)

      if (command.action === "persona.read") return platform.persona.read()
      if (command.action === "persona.reset") {
        await platform.persona.delete()
        return null
      }
      if (Buffer.byteLength(command.content) > 65536) throw new Error("Persona exceeds 64 KiB.")

      return platform.persona.write({ content: command.content })
    }
    if (token && origin !== this.settings.origin)
      throw new Error("The Human credential requires the paired Nexus origin.")
    const member = token ? new Client({ baseURL: this.settings.origin, credential: token }) : active.member
    const principal = token ? (await member.profile.fetch()).member : undefined
    if (principal && principal.kind !== "human") throw new Error("Use a Human member token.")
    if (command.action === "application.approve") {
      if (!principal) throw new Error("A Human member token is required.")

      const space = member.workspace(command.workspace)
      const [chat, run] = await Promise.all([
        space.conversation(command.conversation).fetch(),
        space.run(command.run).fetch(),
      ])

      if (chat.workspace_public_id !== command.workspace) throw new Error("Unknown Nexus workspace.")

      if (
        chat.archived_at ||
        (command.always && chat.answering_user_public_id !== active.identity.agent) ||
        run.turn?.conversation_public_id !== command.conversation
      )
        throw new Error("The held task does not belong to this agent conversation.")

      return new Operations(member, active.application, active.identity).command({
        action: "approve",
        addressed: chat.answering_user_public_id !== active.identity.agent,
        workspace: command.workspace,
        run: command.run,
        task: command.task,
        always: command.always,
      })
    }
    if (command.action === "bot.submit") return active.application.bots.submit(command, member)
    if (command.action === "application.memory") {
      const result = await conversationMemory(member, {
        ...command,
        workspace: command.workspace ?? active.identity.workspace,
      })
      return command.format === "json" ? result.value : result.text
    }
    if (command.action === "application.operation") {
      const operation = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(command.operation)
      const result = await new Operations(member, active.application, {
        ...active.identity,
        workspace: command.workspace ?? active.identity.workspace,
      }).command(operation)

      return result ?? null
    }
    if (command.action === "application.skills") {
      const catalog = Schema.decodeUnknownSync(
        Schema.Struct({
          agent: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.NullOr(Schema.String) })),
          workspace: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.NullOr(Schema.String) })),
        }),
      )(await active.application.operations.command({ action: "skills" }))
      const rows = [...catalog.agent, ...catalog.workspace, ...(this.extensionManager?.documents() ?? [])]

      return [
        ...new Map(rows.map((row) => [row.name, { name: row.name, description: row.description ?? "" }])).values(),
      ]
    }
    if (command.action === "application.accepted") {
      const chat = await member.workspace(command.workspace).conversation(command.conversation).fetch()
      if (chat.answering_user_public_id !== active.identity.agent || chat.side)
        throw new Error("Unknown Main conversation.")
      void active.application.titles.accept(
        command,
        command.input,
        { kind: "direct_reply", text: command.text, model: command.model ? { model: command.model } : undefined },
        command.replayed,
      )
      return null
    }
    if (command.action === "application.open") return active.application.open(command)
    if (command.action === "application.result")
      return member
        .workspace(command.workspace)
        .conversation(command.conversation)
        .inputExecution(command.input)
        .recover()
        .then(executionSnapshot)
    if (command.action === "application.prepare" || command.action === "application.submit") {
      const conversation = await member.workspace(command.workspace).conversation(command.conversation).fetch()
      const bot = conversation.metadata["opencode.bot"]
      if (typeof bot === "string") {
        const input = {
          action: "bot.submit" as const,
          id: bot,
          key: command.key,
          workspace: command.workspace,
          conversation: command.conversation,
          text: command.text,
          model: command.model,
          delivery: command.delivery,
          expected_steering_run_public_id: command.target,
        }
        if (command.action === "application.prepare") {
          await active.application.bots.capture(input, member)
          return null
        }
        return active.application.bots.submit(input, member)
      }
      const input = {
        ...command,
        action: "application.submit" as const,
        principal: principal?.public_id,
        ...(command.addressed && conversation.default_runner?.executor_public_id === active.identity.runner
          ? {
              executor_contexts: {
                [active.identity.runner]: await active.application.environments.capture(
                  command.workspace,
                  command.conversation,
                  active.identity.runner,
                ),
              },
            }
          : {}),
        preparation: () =>
          this.policy(command.workspace, command.conversation, command.preset, command.model ?? undefined),
      }

      if (command.action === "application.prepare") {
        await active.application.captureInput(input, member)
        return null
      }
      return active.application.submit(input, member)
    }

    const selected =
      "workspace" in command ? (command.workspace ?? active.identity.workspace) : active.identity.workspace
    const workspace = member.workspace(selected)
    if (command.action === "schedule.list")
      return command.conversation
        ? workspace.conversation(command.conversation).schedules.list({ after: command.after })
        : workspace.schedules.list({ after: command.after })
    if (command.action === "memory.collections") return workspace.memoryCollections.list()
    if ("conversation" in command) {
      const chat = workspace.conversation(command.conversation)
      const schedules = chat.schedules
      if (command.action === "schedule.read") return schedules.fetch(command.id)
      if (command.action === "schedule.executions") return schedules.executions(command.id, { after: command.after })

      const info = await chat.fetch()
      if (info.side || info.archived_at || info.answering_user_public_id !== active.identity.agent)
        throw new Error("Unknown active agent conversation.")
      if (command.action === "schedule.defaults") {
        const defaults = await active.application.prepare(undefined, {
          workspace: selected,
          conversation: command.conversation,
        })
        const selection = await active.application.selectModel(selected, info, undefined, defaults.model)
        const mode = defaults.agent_configuration.approval_mode

        return { model: selection?.model ?? null, approval: mode === "rules" || mode === "bypass" ? mode : "ask" }
      }
      if (command.action === "schedule.create") {
        const policy = await this.policy(selected, command.conversation, undefined, undefined, info)
        const selection =
          info.agent_configuration_present && !command.model
            ? undefined
            : await active.application.selectModel(selected, info, command.model, policy.model)
        const requested = command.tool_names
        return (
          await schedules.create(
            {
              prompt: command.prompt,
              name: command.name,
              rule: command.rule,
              model: scheduleModel(command, selection?.model),
              model_selection: selection,
              fallback_models: command.fallback_models
                ? [...command.fallback_models]
                : info.agent_configuration_present
                  ? undefined
                  : policy.fallback_models,
              answering_user_public_id: active.identity.agent,
              approval_mode: command.approval ?? "ask",
              tool_names: requested ? policy.tools.filter((name) => requested.includes(name)) : policy.tools,
              executor_contexts: policy.executor_contexts,
            },
            { idempotencyKey: command.key },
          )
        ).schedule
      }
      if (!("id" in command)) throw new Error("Unknown conversation command.")
      if (command.action === "schedule.update") {
        const requested = command.tool_names
        const tools =
          requested &&
          (await this.policy(selected, command.conversation, undefined, undefined, info)).tools.filter((name) =>
            requested.includes(name),
          )
        return schedules.update(command.id, {
          expected_lock_version: command.version,
          name: command.name,
          model: scheduleModel(command, command.model),
          fallback_models: command.fallback_models && [...command.fallback_models],
          tool_names: tools,
          approval_mode: command.approval,
          rule: command.rule,
          prompt: command.prompt,
        })
      }
      if (command.action === "schedule.pause") return schedules.pause(command.id)
      if (command.action === "schedule.resume") return schedules.resume(command.id)
      if (command.action === "schedule.cancel") return schedules.cancel(command.id)
      if (command.action === "schedule.run") return schedules.run(command.id)
      throw new Error("Unknown schedule command.")
    }
    const collections = workspace.memoryCollections
    if (command.action === "memory.create") return collections.create({ name: command.name })
    if (!("collection" in command)) throw new Error("Unknown Nexus command.")
    const collection = await collections.fetch(command.collection)
    if (collection.scope !== "workspace" || collection.owner_public_id !== selected)
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
    return [
      ...this.approvals.map((grant) => grant.rule),
      ...[...this.sites].map((site) => ({
        tool: "web_fetch",
        path: "url",
        match: site + "/*",
        verdict: "allow" as const,
      })),
    ]
  }

  private grantRule(grant: ApprovalGrant) {
    const active = this.connection
    const pending = this.declaring.then(async () => {
      if (!active || active !== this.connection) throw new Error("Nexus connection changed.")
      if (this.approvals.some((value) => JSON.stringify(value.rule) === JSON.stringify(grant.rule)))
        return "already" as const

      await this.declareProfile(active, { signal: this.stop.signal }, [...this.siteRules(), grant.rule])
      this.approvals.push(grant)
      return "saved" as const
    })
    this.declaring = pending.then(
      () => {},
      () => {},
    )
    return pending
  }

  grant(workspace: string, conversation: string, runID: string, key: string) {
    const active = this.connection
    const signal = this.stop.signal
    const pending = this.declaring.then(async () => {
      if (!active || active !== this.connection) throw new Error("Nexus connection changed.")
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
      await this.declareProfile(active, { signal }, [...this.siteRules(), rule])
      this.sites.add(site)
    })
    this.declaring = pending.catch(() => {})
    return pending
  }

  async login() {
    if (!this.settings) throw new Error("Configure a Nexus origin before signing in.")
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
      await (this.credentials instanceof APIKeyCredentials
        ? (async () => {
            const authority = new DeviceFlow({ baseURL: this.settings!.origin })
            await authority.revoke(await this.credentials!.memberCredential())
            await authority.revoke(await this.credentials!.executorCredential())
            await this.store.delete()
          })()
        : this.credentials?.revoke())
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
      await this.declareProfile(active, { signal: AbortSignal.timeout(5000) }, []).catch(() => {})
    await this.human.close()
    await this.pending?.catch(() => {})
    await this.work
    await this.releaseConnection()
    if (this.credentials instanceof OAuthCredentials) await this.credentials.drain()
  }

  private async releaseConnection() {
    this.connection = undefined
    this.approvals.length = 0
    this.sites.clear()
    await this.extensionManager?.close()
    await this.editorChanges
    await this.editorSessions.close()
    this.publish = undefined
    this.extensionManager = undefined
    this.executor = undefined
  }
}

function scheduleModel(
  command: Extract<typeof NexusCommand.Type, { action: "schedule.create" | "schedule.update" }>,
  model: string | undefined,
) {
  if (model || command.reasoning_effort !== undefined || command.reasoning_enabled !== undefined)
    return { model, reasoning_effort: command.reasoning_effort, reasoning_enabled: command.reasoning_enabled }
}
