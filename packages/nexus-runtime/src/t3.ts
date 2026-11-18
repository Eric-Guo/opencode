import { setTimeout } from "node:timers/promises"
import { basename, isAbsolute, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { APIError, type JsonObject, type JsonValue, type StoreEntry } from "@cybros/agent"
import type { Nexus } from "@opencode/schema/nexus"
import type { NexusApplication } from "./application"
import { definition, type RunnerContext, type RunnerTool } from "./extensions"
import { runnerRefusal } from "./runner-policy"
import { T3Transport, T3Uncertain } from "./t3-transport"
import { T3Catalog } from "./t3-catalog"
import { T3Native } from "./t3-native"
import { outputHead } from "./output-window"

const Workspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({ type: Schema.Literal("existing_worktree"), worktreePath: Schema.NonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.NonEmptyString,
    branch: Schema.optional(Schema.String),
  }),
])
const Settings = Schema.Struct({
  server: Schema.optional(Schema.Literals(["host", "local"])),
  listen_port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  url: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
  default_agent: Schema.optional(Schema.String),
  workspace: Schema.optional(Workspace),
})
const Selection = Schema.Struct({ instanceId: Schema.String, model: Schema.String })
const Question = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  options: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.optional(Schema.String) })),
})
const Item = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  nodeId: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  nativeItemRef: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
  prompt: Schema.optional(Schema.String),
  questions: Schema.optional(Schema.Array(Question)),
  options: Schema.optional(Schema.Array(Schema.Struct({ decision: Schema.String }))),
  input: Schema.optional(Schema.MutableJson),
  output: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  outputIndicatesFailure: Schema.optional(Schema.Boolean),
  outputOmitted: Schema.optional(Schema.Boolean),
  fileName: Schema.optional(Schema.String),
  changes: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, oldPath: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
})
const Projection = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    runtimeMode: Schema.String,
    modelSelection: Selection,
    branch: Schema.NullOr(Schema.String),
    worktreePath: Schema.NullOr(Schema.String),
  }),
  runs: Schema.Array(
    Schema.Struct({ id: Schema.String, ordinal: Schema.Number, status: Schema.String, modelSelection: Selection }),
  ),
  messages: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String, text: Schema.String })),
  runtimeRequests: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      nodeId: Schema.String,
      status: Schema.String,
      kind: Schema.String,
      responseCapability: Schema.Struct({ type: Schema.String, providerSessionId: Schema.optional(Schema.String) }),
    }),
  ),
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      parentNodeId: Schema.optional(Schema.NullOr(Schema.String)),
      nativeItemRef: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    }),
  ),
  turnItems: Schema.Array(Item),
  providerSessions: Schema.Array(
    Schema.Struct({ id: Schema.String, status: Schema.String, cwd: Schema.optional(Schema.String) }),
  ),
  subagents: Schema.Array(
    Schema.Struct({
      status: Schema.String,
      title: Schema.optional(Schema.String),
      model: Schema.optional(Schema.MutableJson),
      description: Schema.optional(Schema.String),
    }),
  ),
})
type Projection = typeof Projection.Type
const Record = Schema.Struct({
  conversation: Schema.String,
  thread: Schema.String,
  command: Schema.String,
  message: Schema.String,
  owner: Schema.Struct({ run: Schema.String, task: Schema.String }),
  title: Schema.String,
  environment: Schema.Struct({
    url: Schema.String,
    projectId: Schema.String,
    workspaceStrategy: Workspace,
    runtimeMode: Schema.Literal("approval-required"),
    interactionMode: Schema.Literal("default"),
    modelSelection: Selection,
  }),
  selection: Schema.Struct({ agent: Schema.String, harness: Schema.String, model: Schema.String }),
  placement: Schema.optional(
    Schema.Struct({ branch: Schema.NullOr(Schema.String), worktreePath: Schema.NullOr(Schema.String) }),
  ),
  pending_command: Schema.optional(
    Schema.NullOr(Schema.Struct({ key: Schema.String, message: Schema.String, command: Schema.String })),
  ),
})
type Record = typeof Record.Type
type Work = { entry: StoreEntry; value: Record }
const Delegate = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536)),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  work_id: Schema.optional(Schema.NonEmptyString),
  agent: Schema.optional(Schema.NonEmptyString),
  model: Schema.optional(Schema.NonEmptyString),
})
const Control = Schema.Struct({
  action: Schema.Literals(["agents", "list", "observe", "steer", "stop", "forget"]),
  work_id: Schema.optional(Schema.NonEmptyString),
  prompt: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536))),
})
const Projects = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, workspaceRoot: Schema.String })),
})
const terminal = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"])

export { t3Configuration } from "./t3-settings"

export class T3Client {
  readonly settings
  private readonly transport: T3Transport
  private readonly native: T3Native

  constructor(
    input: unknown,
    private readonly options: {
      application(): NexusApplication
      directory: string
      storage: string
      signal: AbortSignal
      configure?: (operations: Nexus.ExtensionChange["operations"]) => Promise<unknown>
    },
  ) {
    const value = Schema.decodeUnknownSync(Settings)(input)
    const server = value.server ?? "host"
    const url =
      server === "local" ? "http://127.0.0.1:" + (value.listen_port ?? 3773) : (value.url?.replace(/\/$/, "") ?? "")
    if (url) {
      const parsed = new URL(url)
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== "/"
      )
        throw new Error("T3 URL must be an HTTP service origin without credentials, path, query or fragment.")
    }
    this.settings = {
      server,
      url,
      token: value.token ?? "",
      project_id: value.project_id ?? value.project ?? "",
      default_agent: value.default_agent,
      workspace: value.workspace ?? { type: "root" as const },
      listen_port: value.listen_port ?? 3773,
    }
    this.transport = new T3Transport(url, this.settings.token)
    this.native = new T3Native(options.storage, options.directory)
  }

  async start() {
    if (this.settings.server === "local") await this.native.start(this.settings.listen_port, this.options.signal)
  }

  close() {
    return this.native.close()
  }

  status() {
    const issues = [
      !this.settings.url && "Set the host T3 service URL.",
      !this.settings.token && "Save a T3 bearer.",
      !this.settings.project_id && "Select a T3 project.",
      this.settings.server === "local" && !this.native.running() && "The local T3 service is not running.",
    ].filter((value): value is string => typeof value === "string")
    return { ready: !issues.length, issues }
  }

  async command(input: JsonValue): Promise<JsonValue> {
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        action: Schema.String,
        id: Schema.optional(Schema.String),
        path: Schema.optional(Schema.String),
        token: Schema.optional(Schema.String),
        provider: Schema.optional(Schema.String),
        api_key: Schema.optional(Schema.String),
      }),
    )(input)
    if (value.action === "t3.status")
      return {
        ...this.status(),
        server: this.settings.server,
        url: this.settings.url,
        project_id: this.settings.project_id,
        bearer: this.settings.token ? "saved" : "none",
        running: this.native.running(),
        ...(this.settings.server === "local"
          ? { installed: this.native.installed(), native_configuration: this.native.root }
          : {}),
      }
    if (value.action === "t3.agents") return (await this.catalog(this.options.signal)).report()
    if (value.action === "t3.projects") return this.projects()
    if (value.action === "t3.check")
      return {
        ...this.status(),
        service: { authenticated: true, orchestration_protocol: 2 },
        providers: (await this.catalog(this.options.signal)).report(),
        project_available: (await this.projects()).some((row) => row.id === this.settings.project_id),
      }
    if (value.action === "t3.login") {
      if (this.settings.server !== "local") throw new Error("Run native login on the host that owns T3.")
      if (value.id) return this.native.loginStatus(value.id)
      return this.native.login(value.provider ?? "", value.api_key, this.options.signal)
    }
    if (!this.options.configure) throw new Error("T3 setup needs the extension configuration owner.")
    if (value.action === "t3.token") {
      const token =
        value.token?.trim() ?? (this.settings.server === "local" ? await this.native.token(this.options.signal) : "")
      if (!/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new Error("Supply a T3 bearer without whitespace.")
      await this.options.configure([{ op: "set", path: ["token"], value: token }])
      return { bearer: "saved", restart_required: true }
    }
    const projects = await this.projects()
    if (value.action === "t3.project") {
      const project = projects.find((row) => row.id === value.id)
      if (!project) throw new Error("Choose an ID from t3.projects.")
      await this.options.configure([{ op: "set", path: ["project_id"], value: project.id }])
      return project
    }
    if (value.action === "t3.create") {
      if (!value.path || !isAbsolute(value.path))
        throw new Error("Supply an absolute path in T3's execution environment.")
      const matches = projects.filter((row) => row.workspaceRoot === value.path)
      if (matches.length > 1) throw new Error("Several T3 projects use this path; choose an ID.")
      const project =
        matches[0] ??
        (await this.transport
          .http(
            "POST",
            "/api/projects/mutate",
            {
              type: "project.create",
              commandId: crypto.randomUUID(),
              projectId: crypto.randomUUID(),
              title: basename(value.path),
              workspaceRoot: value.path,
            },
            this.options.signal,
          )
          .then((row) => Schema.decodeUnknownSync(Projects.fields.projects.value)(row))
          .catch(async (error: unknown) => {
            if (!(error instanceof T3Uncertain)) throw error
            const found = (await this.projects()).filter((row) => row.workspaceRoot === value.path)
            if (found.length !== 1)
              throw new T3Uncertain("Project creation was not confirmed; inspect t3.projects before creating again.")
            return found[0]
          }))
      await this.options.configure([{ op: "set", path: ["project_id"], value: project.id }])
      return project
    }
    throw new Error("Unknown T3 setup command.")
  }

  tools(): RunnerTool[] {
    if (!this.settings.url || !this.settings.token || !this.settings.project_id) return []
    const effect = {
      kind: "write",
      destructive: true,
      effect_scope: "open",
      idempotency: "keyed",
      reconciliation: "lookup",
    } as const
    return [
      {
        role: "agent",
        definition: {
          ...definition(
            "delegate_coding",
            "Delegate a complete coding assignment to an available coding agent. Discover supported agent/model choices with coding_work action=agents. Waits for completion and relays questions; use work_id to continue the original environment. Observe uncertain work before another launch.",
            {
              prompt: { type: "string", minLength: 1, maxLength: 65536 },
              title: { type: "string", minLength: 1, maxLength: 200 },
              work_id: { type: "string", minLength: 1 },
              agent: { type: "string", minLength: 1 },
              model: { type: "string", minLength: 1 },
            },
            ["prompt"],
          ),
          effect_profile: effect,
          timeout_ms: 3600000,
        },
        execute: (value, context) => this.delegate(Schema.decodeUnknownSync(Delegate)(value), context),
      },
      {
        role: "agent",
        definition: {
          ...definition(
            "coding_work",
            "Discover agents or list, observe, steer, stop and forget this conversation's coding work. Stop requests cancellation; observe completion separately.",
            {
              action: { enum: ["agents", "list", "observe", "steer", "stop", "forget"] },
              work_id: { type: "string", minLength: 1 },
              prompt: { type: "string", minLength: 1, maxLength: 65536 },
            },
            ["action"],
          ),
          effect_profile: effect,
          timeout_ms: 60000,
        },
        execute: (value, context) => this.control(Schema.decodeUnknownSync(Control)(value), context),
      },
    ]
  }

  private catalog(signal: AbortSignal) {
    return this.transport.call("server.getConfig", {}, signal).then((value) => new T3Catalog(value))
  }
  private projects() {
    return this.transport
      .http("GET", "/api/projects", undefined, this.options.signal)
      .then((value) => [...Schema.decodeUnknownSync(Projects)(value).projects])
  }
  private store(context: RunnerContext) {
    if (!context.conversation) throw new Error("Coding work requires a conversation-owned task.")
    return this.options.application().client.workspace(context.workspace).conversation(context.conversation)
      .storeEntries
  }
  private async records(context: RunnerContext) {
    const store = this.store(context)
    const records: Work[] = []
    let after: string | undefined
    do {
      const page = await store.list({ after, limit: 100 }, { signal: context.signal })
      for (const row of page.items.filter((row) => row.namespace === "opencode.t3")) {
        const entry = await store.fetch(row.public_id, { signal: context.signal })
        const value = Schema.decodeUnknownSync(Record)(entry.value)
        if (value.conversation === context.conversation) records.push({ entry, value })
      }
      after = page.next_after ?? undefined
    } while (after)
    return records
  }
  private async record(id: string, context: RunnerContext): Promise<Work> {
    const entry = await this.store(context).fetch(id, { signal: context.signal })
    const value = Schema.decodeUnknownSync(Record)(entry.value)
    if (entry.namespace !== "opencode.t3" || value.conversation !== context.conversation)
      throw new Error("Coding work belongs to another conversation.")
    const { modelSelection, ...environment } = value.environment
    if (!isDeepStrictEqual(environment, this.environment()))
      throw new Error("Restore the coding work's original connection and workspace before continuing.")
    return { entry, value }
  }
  private environment() {
    return {
      url: this.settings.url,
      projectId: this.settings.project_id,
      workspaceStrategy: this.settings.workspace,
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
    }
  }
  private async update(work: Work, changes: Partial<Record>, context: RunnerContext) {
    const value = { ...work.value, ...changes }
    const entry = await this.store(context).update(
      work.entry.public_id,
      { value: json(value), lock_version: work.entry.lock_version },
      { signal: context.signal },
    )
    work.entry = entry
    work.value = Schema.decodeUnknownSync(Record)(entry.value)
  }
  private async projection(work: Work, signal: AbortSignal, verify = true) {
    const raw = await this.transport.call("orchestration.getThreadProjection", { threadId: work.value.thread }, signal)
    const value = Schema.decodeUnknownOption(Projection)(raw)
    if (value._tag === "None") throw new Error("T3 returned an incomplete thread projection.")
    const projection = value.value
    if (projection.thread.id !== work.value.thread || projection.thread.projectId !== work.value.environment.projectId)
      throw new Error("T3 projection differs from the accepted work environment.")
    if (verify) this.verify(work, projection)
    return projection
  }
  private verify(work: Work, value: Projection) {
    const latest = value.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]
    if (
      value.thread.runtimeMode !== "approval-required" ||
      !isDeepStrictEqual(value.thread.modelSelection, work.value.environment.modelSelection) ||
      (latest && !isDeepStrictEqual(latest.modelSelection, work.value.environment.modelSelection))
    )
      throw new Error("The native permission mode, model or provider changed.")
    if (
      work.value.placement &&
      !isDeepStrictEqual(work.value.placement, { branch: value.thread.branch, worktreePath: value.thread.worktreePath })
    )
      throw new Error("The native branch or worktree changed.")
  }
  private ownerActive(owner: Record["owner"], context: RunnerContext) {
    return this.options
      .application()
      .client.workspace(context.workspace)
      .run(owner.run)
      .task(owner.task)
      .fetch({ signal: context.signal })
      .then((detail) => !["completed", "failed", "canceled", "timed_out", "skipped"].includes(detail.task.status))
      .catch((error: unknown) => {
        if (error instanceof APIError && error.status === 404) return false
        throw error
      })
  }

  private async delegate(input: typeof Delegate.Type, context: RunnerContext) {
    if (!context.ask) throw new Error("Coding delegation requires claim-scoped questions.")
    const key = context.run + ":" + context.task
    const found = input.work_id ?? (await this.records(context)).find((row) => row.entry.key === key)?.entry.public_id
    const prior = found ? await this.record(found, context) : undefined
    const owner = { run: context.run, task: context.task }
    const work =
      prior ??
      (await (async (): Promise<Work> => {
        const selected = (await this.catalog(context.signal)).select(
          input.agent ?? this.settings.default_agent,
          input.model,
        )
        const value: Record = {
          conversation: context.conversation!,
          thread: crypto.randomUUID(),
          command: crypto.randomUUID(),
          message: crypto.randomUUID(),
          owner,
          title: input.title ?? "Coding assignment",
          environment: {
            ...this.environment(),
            modelSelection: { instanceId: selected.instanceId, model: selected.model },
          },
          selection: { agent: selected.agent, harness: selected.harness, model: selected.model },
        }
        const receipt = await this.store(context).create(
          { namespace: "opencode.t3", key, value: json(value) },
          { idempotencyKey: "t3:" + key, signal: context.signal },
        )
        return { entry: receipt.store_entry, value }
      })())
    if (
      (input.agent &&
        ![work.value.selection.agent, work.value.selection.harness].some(
          (name) => name.toLowerCase() === input.agent!.toLowerCase(),
        )) ||
      (input.model && input.model !== work.value.selection.model)
    )
      throw new Error("Existing coding work retains its original agent and model.")

    try {
      if (!prior) {
        await this.transport
          .call(
            "orchestration.launchThread",
            {
              ...work.value.environment,
              url: undefined,
              threadId: work.value.thread,
              commandId: work.value.command,
              title: work.value.title,
              initialMessage: { messageId: work.value.message, text: input.prompt, attachments: [] },
            },
            context.signal,
          )
          .catch(async (error: unknown) => {
            if (!(error instanceof T3Uncertain)) throw error
            const current = await this.projection(work, context.signal)
            if (!current.messages.some((message) => message.id === work.value.message)) throw error
          })
      } else if (input.work_id && !isDeepStrictEqual(owner, work.value.owner)) {
        const current = await this.projection(work, context.signal)
        if (!settled(current) || (await this.ownerActive(work.value.owner, context)))
          throw new Error("Coding work is still active; use steer.")
        await this.update(work, { owner, pending_command: null }, context)
        await this.send(work, input.prompt, { type: "start_immediately" }, context)
      } else {
        const current = await this.projection(work, context.signal)
        const message = input.work_id ? work.value.pending_command?.message : work.value.message
        if (!current.messages.some((row) => row.id === message))
          throw new T3Uncertain("The original message was not found; no duplicate was sent.")
      }
      while (true) {
        context.signal.throwIfAborted()
        const current = await this.projection(work, context.signal)
        if (!work.value.placement)
          await this.update(
            work,
            { placement: { branch: current.thread.branch, worktreePath: current.thread.worktreePath } },
            context,
          )
        if (settled(current)) return this.result(work, current, context, true)
        await context.progress?.(
          work.value.selection.agent +
            " work " +
            work.entry.public_id +
            ": " +
            (current.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]?.status ?? "starting"),
        )
        for (const request of current.runtimeRequests.filter((row) => row.status === "pending"))
          await this.respond(work, current, request, context)
        if (current.runtimeRequests.some((row) => row.status === "pending")) {
          const refreshed = await this.projection(work, context.signal)
          if (settled(refreshed)) return this.result(work, refreshed, context, true)
        }
        await setTimeout(1000, undefined, { signal: context.signal })
      }
    } catch (error) {
      if (!isDeepStrictEqual(work.value.owner, owner)) throw error
      const stop = await this.projection(work, AbortSignal.timeout(5000), false)
        .then((current) => this.stop(work, current, AbortSignal.timeout(5000)))
        .then(
          () => "Native Stop requested or already settled.",
          () => "Native Stop could not be confirmed.",
        )
      if (context.signal.aborted) throw context.signal.reason
      const Failure = error instanceof T3Uncertain ? T3Uncertain : Error
      throw new Failure(
        (error instanceof Error ? error.message : "Coding work failed.") +
          " Work ID: " +
          work.entry.public_id +
          ". " +
          stop +
          " Observe this work before launching a replacement.",
      )
    }
  }

  private async control(input: typeof Control.Type, context: RunnerContext) {
    if (input.action === "agents")
      return {
        content: JSON.stringify({
          agents: (await this.catalog(context.signal)).report(),
          default_agent: this.settings.default_agent,
        }),
      }
    if (input.action === "list")
      return {
        content: JSON.stringify({
          work: (await this.records(context)).map((work) => ({
            work_id: work.entry.public_id,
            title: work.value.title,
            ...work.value.selection,
          })),
        }),
      }
    if (!input.work_id) return { is_error: true, content: "work_id is required for coding_work action=" + input.action }
    const prompt = input.prompt
    if (input.action === "steer" && !prompt)
      return { is_error: true, content: "prompt is required for coding_work action=steer" }

    const work = await this.record(input.work_id, context)
    const current = await this.projection(work, context.signal, input.action === "steer")
    if (input.action === "observe") return this.result(work, current, context, false)
    if (input.action === "stop") {
      await this.stop(work, current, context.signal)
      await this.options
        .application()
        .client.workspace(context.workspace)
        .run(work.value.owner.run)
        .task(work.value.owner.task)
        .cancel({ signal: context.signal })
        .catch(async (error: unknown) => {
          if (
            error instanceof APIError &&
            (error.status === 404 || (error.status === 409 && !(await this.ownerActive(work.value.owner, context))))
          )
            return
          throw error
        })
      return { content: "Stop requested; observe completion separately." }
    }
    if (input.action === "forget") {
      if (!settled(current) || (await this.ownerActive(work.value.owner, context)))
        throw new Error("Stop and settle the native work and its owning Nexus task before forgetting it.")
      await this.store(context).delete(
        work.entry.public_id,
        { lock_version: work.entry.lock_version },
        { signal: context.signal },
      )
      return { content: "Removed the continuation; committed results remain in history." }
    }
    if (settled(current) || !(await this.ownerActive(work.value.owner, context)))
      throw new Error("This coding task no longer owns active work.")
    const run = current.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]
    if (!run) throw new Error("Coding work has no active run to steer.")
    await this.send(work, prompt!, { type: "steer_active", targetRunId: run.id }, context)
    return { content: "Steering submitted for coding work " + work.entry.public_id + "." }
  }

  private async send(work: Work, prompt: string, mode: JsonObject, context: RunnerContext) {
    const key = context.run + ":" + context.task
    const previous = work.value.pending_command?.key === key
    if (!previous)
      await this.update(
        work,
        { pending_command: { key, message: crypto.randomUUID(), command: crypto.randomUUID() } },
        context,
      )
    const pending = work.value.pending_command!
    const reconcile = async () => {
      if (!(await this.projection(work, context.signal)).messages.some((row) => row.id === pending.message))
        throw new T3Uncertain("The continuation message was not found; no duplicate was sent.")
    }
    if (previous) return reconcile()
    await this.transport
      .call(
        "orchestration.dispatchCommand",
        {
          type: "message.dispatch",
          threadId: work.value.thread,
          commandId: pending.command,
          messageId: pending.message,
          createdBy: "agent",
          creationSource: "server",
          text: prompt,
          attachments: [],
          dispatchMode: mode,
        },
        context.signal,
      )
      .catch((error: unknown) => {
        if (!(error instanceof T3Uncertain)) throw error
        return reconcile()
      })
  }

  private stop(work: Work, current: Projection, signal: AbortSignal) {
    const run = current.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]
    if (!run || settled(current)) return Promise.resolve(null)
    return this.transport.call(
      "orchestration.dispatchCommand",
      {
        type: "run.interrupt",
        commandId: "opencode:" + work.value.thread + ":stop:" + run.id,
        threadId: work.value.thread,
        runId: run.id,
        holdQueue: true,
        reason: "Stopped by Nexus",
      },
      signal,
    )
  }

  private async respond(
    work: Work,
    current: Projection,
    request: Projection["runtimeRequests"][number],
    context: RunnerContext,
  ) {
    if (!live(current, request)) throw new Error("Native request is no longer resumable.")
    const item = current.turnItems.find((row) => row.requestId === request.id)
    if (!item) throw new Error("Native request details are unavailable.")
    const ask = (part: string, prompt: string, choices?: string[]) =>
      context.ask!(
        "t3_" +
          createHash("sha256")
            .update(request.id + ":" + part)
            .digest("hex")
            .slice(0, 32),
        "Coding work " + work.entry.public_id + "\n" + prompt,
        choices?.length ? choices : undefined,
      )
    const payload: JsonObject = {}
    if (request.kind === "user_input") {
      if (!item.questions?.length) throw new Error("Native questions are unavailable.")
      const answers: JsonObject = {}
      for (const question of item.questions) {
        const labels = question.options.map((row) => row.label)
        const answer = await ask(
          question.id,
          question.question +
            (question.multiSelect ? "\nReturn a JSON array of labels: " + JSON.stringify(labels) : ""),
          question.multiSelect ? undefined : labels,
        )
        const selected = question.multiSelect
          ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(answer)
          : [answer]
        const values = selected.map((label) => {
          const option = question.options.find((row) => row.label === label)
          if (!option && labels.length && question.allowCustomAnswer === false)
            throw new Error("Choose an offered native answer.")
          return option?.value ?? label
        })
        answers[question.id] = question.multiSelect ? values : values[0]
      }
      payload.answers = answers
    } else {
      const node = current.nodes.find((row) => row.id === request.nodeId)
      const action =
        node &&
        current.turnItems.find(
          (row) =>
            !row.requestId &&
            (row.nodeId === node.parentNodeId ||
              (node.nativeItemRef?.nativeId && isDeepStrictEqual(row.nativeItemRef, node.nativeItemRef))),
        )
      const cwd = current.providerSessions.find((row) => row.id === request.responseCapability.providerSessionId)?.cwd
      const refusal = (() => {
        if (item.options && !item.options.some((row) => row.decision === "accept"))
          return "No one-shot approval is offered."
        if (request.kind === "file-read") return
        if (request.kind === "command")
          return action?.type === "command_execution" && typeof action.input === "string"
            ? runnerRefusal("bash", { command: action.input }, cwd ?? context.directory, [this.options.storage])
            : "Native command identity unavailable."
        if (request.kind === "file-change" || request.kind === "file_change") {
          if (action?.type !== "file_change" || !cwd) return "Native edit identity unavailable."
          const paths =
            action.changes?.flatMap((row) =>
              [row.path, row.oldPath].filter((path): path is string => typeof path === "string"),
            ) ?? (action.fileName ? [action.fileName] : [])
          if (!paths.length) return "Native edit paths unavailable."
          return paths
            .map((path) => runnerRefusal("write", { path: resolve(cwd, path) }, cwd, [this.options.storage]))
            .find(Boolean)
        }
        return "The native request does not identify a one-shot action."
      })()
      payload.decision =
        !refusal &&
        (await ask("approval", (item.prompt ?? "Approve this native action?") + "\n" + JSON.stringify(action), [
          "accept",
          "decline",
        ])) === "accept"
          ? "accept"
          : "decline"
      if (refusal) await context.progress?.("Native action refused: " + refusal)
    }
    const fresh = await this.projection(work, context.signal)
    const pending = fresh.runtimeRequests.find((row) => row.id === request.id && row.status === "pending")
    if (!pending || !live(fresh, pending))
      throw new Error("Native request expired while awaiting the answer; no permission was forwarded.")
    await this.transport.call(
      "orchestration.dispatchCommand",
      {
        type: "runtime-request.respond",
        commandId: "opencode:" + work.value.thread + ":response:" + request.id,
        threadId: work.value.thread,
        requestId: request.id,
        ...payload,
      },
      context.signal,
    )
  }

  private async result(work: Work, current: Projection, context: RunnerContext, capture: boolean) {
    const run = current.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]
    const summary: JsonObject = {
      work_id: work.entry.public_id,
      agent: work.value.selection.agent,
      harness: work.value.selection.harness,
      model: (run ?? current.thread).modelSelection.model,
      status: run?.status ?? "not_started",
      worktree: current.thread.worktreePath,
      branch: current.thread.branch,
      requests: json(
        current.runtimeRequests
          .filter((row) => row.status === "pending")
          .map((row) => {
            const item = current.turnItems.find((item) => item.requestId === row.id)
            return {
              kind: row.kind,
              prompt: item?.prompt,
              questions: (item?.questions ?? []).map((question) => ({
                prompt: question.question,
                options: question.options.map((option) => option.label),
              })),
            }
          }),
      ),
    }
    const checks = await Promise.all(
      current.turnItems
        .filter((item) => item.type === "command_execution")
        .map(async (item) => {
          const full =
            capture && item.outputOmitted && item.id
              ? await this.transport
                  .call("orchestration.getTurnItem", { threadId: work.value.thread, itemId: item.id }, context.signal)
                  .then(
                    (value) =>
                      Schema.decodeUnknownSync(Schema.Struct({ item: Schema.NullOr(Item) }))(value).item ?? item,
                  )
                  .catch(() => item)
              : item
          return json({
            input: full.input,
            output: full.output,
            exitCode: full.exitCode,
            outputIndicatesFailure: full.outputIndicatesFailure,
            outputOmitted: full.outputOmitted,
          })
        }),
    )
    const diff =
      capture && context.publish
        ? await this.transport
            .call(
              "orchestration.getFullThreadDiff",
              { threadId: work.value.thread, toTurnCount: run!.ordinal, ignoreWhitespace: false },
              context.signal,
            )
            .then((value) => Schema.decodeUnknownSync(Schema.Struct({ diff: Schema.String }))(value).diff)
            .catch(() => undefined)
        : undefined
    context.signal.throwIfAborted()
    if (capture && context.publish && diff === undefined)
      summary.limitation = "Final diff unavailable; reported native results and checks remain available."

    const report = {
      ...summary,
      text: current.messages
        .filter((row) => row.role === "assistant")
        .map((row) => row.text)
        .join("\n"),
      checks,
      workers: current.subagents,
    }
    const files: JsonObject[] = []
    if (capture && context.publish) {
      files.push(
        await context.publish(
          new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
          "coding-" + work.entry.public_id + ".json",
        ),
      )
      if (diff !== undefined)
        files.push(
          await context.publish(new Blob([diff], { type: "text/x-diff" }), "coding-" + work.entry.public_id + ".diff"),
        )
    }
    const output = outputHead(JSON.stringify(report))
    const text = output.truncation
      ? files.length
        ? "[Coding report exceeds the inline output limit. See the attached JSON report.]"
        : "[Coding report exceeds the inline output limit. Review the structured work summary.]"
      : output.text
    return {
      content: files.length ? [{ type: "text", text }, ...files] : text,
      structured_content: summary,
      is_error: !!settled(current) && run?.status !== "completed",
    }
  }
}

function settled(value: Projection) {
  const run = value.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]
  return (
    !!run &&
    terminal.has(run.status) &&
    !value.subagents.some((row) => ["pending", "running", "waiting"].includes(row.status))
  )
}
function live(value: Projection, request: Projection["runtimeRequests"][number]) {
  if (request.responseCapability.type === "message") return request.kind === "user_input"
  return (
    request.responseCapability.type === "live" &&
    value.providerSessions.some(
      (row) =>
        row.id === request.responseCapability.providerSessionId && ["ready", "running", "waiting"].includes(row.status),
    )
  )
}
function json(value: unknown) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(JSON.stringify(value))
}

/** @deprecated Compose T3Client with the application and durable storage. Removed in the next minor. */
export function t3Tools(
  endpoint: string,
  credentials: { token: string; project: string },
  options?: ConstructorParameters<typeof T3Client>[1],
) {
  if (!options) throw new Error("T3 delegation requires the Nexus application and durable conversation storage.")
  return new T3Client({ url: endpoint, ...credentials }, options).tools()
}
