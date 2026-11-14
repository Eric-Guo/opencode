import { realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import type { JsonValue } from "@cybros/agent"
import { definition, type RunnerContext, type RunnerTool } from "./extensions"
import { AcpChild, AcpTimeout, type AcpSession } from "./acp-child"
import { AcpCapture } from "./acp-capture"
import { acpExecutable, acpSettings, type AcpAgent } from "./acp-settings"
import { ClaimDeadline } from "./claim-control"
import { NexusAcp } from "@opencode/schema/nexus-acp"

const Input = Schema.Struct({
  agent: Schema.String,
  prompt: Schema.String,
  session: Schema.optional(Schema.String),
  workdir: Schema.optional(Schema.String),
})

type Session = { child: AcpChild; session: AcpSession }

export class AcpClient {
  private readonly settings: ReturnType<typeof acpSettings>
  private readonly children = new Map<string, AcpChild>()
  private readonly sessions = new Map<string, Session>()
  private readonly archives = new Map<string, AcpCapture>()
  private readonly gone = new Set<string>()
  private readonly storage: string
  private closing?: Promise<void>

  constructor(
    input: unknown,
    private readonly options: {
      storage?: string
      directory?: string
      signal?: AbortSignal
      protectedRoots?: readonly string[]
    } = {},
  ) {
    this.settings = acpSettings(input)
    this.storage = options.storage ?? join(tmpdir(), "opencode-nexus-acp-" + crypto.randomUUID())
    options.signal?.addEventListener(
      "abort",
      () => {
        void this.close()
      },
      { once: true },
    )
  }

  async check() {
    await Promise.all(this.settings.agents.filter((agent) => agent.enabled).map((agent) => acpExecutable(agent)))
  }

  status() {
    const issues = this.settings.faults.map((row) => row.name + ": " + row.issue)
    if (!this.settings.agents.some((agent) => agent.enabled)) issues.push("No ACP agents are enabled.")
    return { ready: !this.closing && !issues.length, issues }
  }

  tool(): RunnerTool | undefined {
    const agents = this.settings.agents.filter((agent) => agent.enabled)
    if (!agents.length) return
    return {
      definition: {
        ...definition(
          "delegate_agent",
          "Delegate a complete task to a configured coding agent with its own tools and model. The agent has no parent conversation context. Its commands and edits run as this runner's user, subject to the local refusal floor. The result's session ID continues that session. Agents:\n" +
            agents.map((agent) => "- " + agent.name + ": " + this.safe(agent.description, agent)).join("\n"),
          {
            agent: { type: "string", enum: agents.map((agent) => agent.name) },
            prompt: { type: "string" },
            session: { type: "string", description: "Continue this conversation's existing delegated session." },
            workdir: {
              type: "string",
              description: "Absolute or relative to the runner root; fixed for the session's life.",
            },
          },
          ["agent", "prompt"],
        ),
        timeout_ms: Math.max(...agents.map((agent) => agent.timeout_ms)),
      },
      internalTimeout: true,
      execute: (input, context) => this.delegate(Schema.decodeUnknownSync(Input)(input), context),
    }
  }

  async command(input: Schema.Json): Promise<JsonValue> {
    const command = Schema.decodeUnknownSync(NexusAcp.Command)(input)
    if (command.action === "acp.list")
      return {
        agents: this.settings.agents.map((agent) => ({
          name: agent.name,
          description: this.safe(agent.description, agent),
          enabled: agent.enabled,
          permissions: agent.permissions,
          timeout_ms: agent.timeout_ms,
          model: agent.model ? this.safe(agent.model, agent) : null,
          children: [...this.children.values()].filter((child) => child.agent === agent).length,
        })),
        faults: this.settings.faults,
        sessions: this.documents(),
      }
    if (command.action === "acp.sessions") return this.documents()
    if (command.action === "acp.release") {
      const owner = JSON.stringify([command.workspace, command.conversation])
      await Promise.all(
        [...this.children.values()].filter((child) => child.owner === owner).map((child) => this.retire(child, true)),
      )
      return null
    }
    if (command.action === "acp.probe") {
      const agent = this.agent(command.agent)
      if (this.closing) throw new Error("The ACP client is shutting down.")
      const capture = new AcpCapture(null, agent.secrets)
      const child = new AcpChild(agent, "probe", capture, this.roots())
      try {
        const result = await child.start(
          await this.cwd(command.workdir, this.options.directory ?? process.cwd()),
          AbortSignal.any([
            AbortSignal.timeout(agent.timeout_ms),
            ...(this.options.signal ? [this.options.signal] : []),
          ]),
        )
        return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(
          JSON.stringify(
            {
              protocolVersion: result.protocolVersion,
              agentInfo: result.agentInfo
                ? { name: result.agentInfo.name, version: result.agentInfo.version, title: result.agentInfo.title }
                : null,
              capabilities: result.agentCapabilities ?? {},
              authMethods:
                result.authMethods?.map((method) => ({
                  id: method.id,
                  name: method.name,
                  type: "type" in method && method.type === "terminal" ? "terminal" : "agent",
                })) ?? [],
            },
            (_, value: unknown) => (typeof value === "string" ? capture.redact(value) : value),
          ),
        )
      } finally {
        await child.close()
      }
    }
    if (!("session" in command)) throw new Error("Unknown ACP command.")
    const selected = this.sessions.get(command.session)
    if (command.action === "acp.logs") {
      const capture = selected?.child.capture ?? this.archives.get(command.session)
      if (!capture) throw new Error("Unknown delegated session.")
      return (await capture.read()).slice(-65536)
    }
    if (!selected) throw new Error("Unknown delegated session.")
    await this.retire(selected.child, true)
    return null
  }

  private async delegate(input: typeof Input.Type, context: RunnerContext) {
    if (!context.conversation) throw new Error("A conversation must own a delegated ACP session.")
    const agent = this.agent(input.agent)
    if (this.closing) throw new Error("The ACP client is shutting down.")
    const owner = JSON.stringify([context.workspace, context.conversation])
    const existing = input.session ? this.sessions.get(input.session) : undefined
    if (input.session && (!existing || existing.child.owner !== owner || existing.child.agent !== agent))
      throw new Error(
        this.gone.has(input.session)
          ? "This delegated session has ended; omit session to start a new one."
          : "Choose a session owned by this conversation and agent.",
      )
    const key = JSON.stringify([owner, agent.name])
    const previous = existing?.child ?? this.children.get(key)
    if (previous && !previous.alive) {
      void this.retire(previous, true)
      if (existing) throw new Error("This delegated child has exited; omit session to start a new one.")
    }
    const known = previous?.alive ? previous : undefined
    const child =
      known ??
      new AcpChild(
        agent,
        owner,
        new AcpCapture(join(this.storage, agent.name + "-" + crypto.randomUUID() + ".jsonl"), agent.secrets),
        this.roots(),
      )
    if (!known) {
      this.children.set(key, child)
      void child.closed.then(() => this.forget(key, child))
    }
    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(new AcpTimeout("The delegated agent exceeded its configured timeout.")),
      agent.timeout_ms,
    )
    timer.unref()
    const signal = AbortSignal.any([
      context.signal,
      timeout.signal,
      ...(this.options.signal ? [this.options.signal] : []),
    ])
    const selected = { value: existing?.session, entered: false }
    try {
      const result = await child.serial(signal, async () => {
        selected.entered = true
        const cwd =
          existing && input.workdir === undefined
            ? existing.session.cwd
            : await this.cwd(input.workdir, context.directory)
        if (existing && input.workdir !== undefined && cwd !== existing.session.cwd)
          throw new Error("A delegated session's workdir is fixed; omit session to open a new one there.")
        if (!existing) {
          await child.start(cwd, signal)
          const remote = await child.open(cwd, signal)
          if (this.children.get(key) !== child || child.retired)
            throw new Error("The delegated child was released before its session opened.")
          const session: AcpSession = {
            id: "acp-" + crypto.randomUUID(),
            remote,
            cwd,
            owner,
            calls: 0,
            opened: new Date().toISOString(),
            last_prompt: null,
            tools: new Map(),
          }
          selected.value = session
          child.sessions.set(session.id, session)
          this.sessions.set(session.id, { child, session })
        }
        return child.prompt(selected.value!, input.prompt, context, signal)
      })
      const session = selected.value!
      const transcript = await child.capture.read().catch(() => "")
      const resource =
        transcript && context.publish
          ? await context
              .publish(
                new Blob([transcript], { type: "application/x-ndjson" }),
                agent.name + "-" + session.id + ".jsonl",
              )
              .catch(() => undefined)
          : undefined
      const text =
        result.text +
        result.asks
          .map((ask) => "\n\nThe agent asked: " + ask + " — declined; continue the session with an answer.")
          .join("") +
        "\n\nsession: " +
        session.id +
        " · stop: " +
        result.stop +
        " · calls: " +
        result.calls +
        " (" +
        result.refused +
        " refused by the floor)"
      if (!child.alive) await this.retire(child)
      return {
        content: resource ? [{ type: "text", text }, resource] : text,
        is_error: result.error,
        structured_content: {
          agent: agent.name,
          session: session.id,
          stopReason: result.stop,
          calls: result.calls,
          refused: result.refused,
          usage: result.usage,
        },
      }
    } catch (error) {
      if (signal.aborted && !(signal.reason instanceof AcpTimeout || signal.reason instanceof ClaimDeadline)) {
        if ((!known || selected.entered) && !selected.value) await this.retire(child, true)
        context.signal.throwIfAborted()
        throw signal.reason
      }
      if ((!known || selected.entered) && (!selected.value || !child.alive || signal.aborted))
        await this.retire(child, true)
      return {
        is_error: true,
        content: child.capture.redact(error instanceof Error ? error.message : "The delegated agent failed."),
        structured_content: {
          agent: agent.name,
          session: selected.value?.id ?? null,
          stopReason: signal.aborted ? "timed_out" : "refused",
          calls: 0,
          refused: 0,
          usage: null,
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private agent(name: string) {
    const agent = this.settings.agents.find((agent) => agent.name === name && agent.enabled)
    if (!agent) throw new Error("Choose a configured, enabled ACP agent.")
    return agent
  }

  private roots() {
    return [this.storage, ...(this.options.protectedRoots ?? [])]
  }

  private safe(value: string, agent: AcpAgent) {
    return agent.secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
  }

  private async cwd(path: string | undefined, root: string) {
    const cwd = await realpath(resolve(root, path ?? "."))
    if (!(await stat(cwd)).isDirectory()) throw new Error("Choose a directory for the delegated session.")
    return cwd
  }

  private documents() {
    return [...this.sessions.values()].map((selected) => ({
      id: selected.session.id,
      agent: selected.child.agent.name,
      owner: this.safe(selected.session.owner, selected.child.agent),
      cwd: this.safe(selected.session.cwd, selected.child.agent),
      calls: selected.session.calls,
      opened: selected.session.opened,
      last_prompt: selected.session.last_prompt,
      busy: selected.child.busy,
      pid: selected.child.pid,
    }))
  }

  private forget(key: string, child: AcpChild) {
    if (this.children.get(key) === child) this.children.delete(key)
    this.sessions.forEach((selected, id) => {
      if (selected.child !== child) return
      this.sessions.delete(id)
      this.archives.set(id, child.capture)
      this.gone.add(id)
    })
    Array.from(this.archives.keys())
      .slice(0, -100)
      .forEach((id) => {
        this.archives.delete(id)
        this.gone.delete(id)
      })
  }

  private async retire(child: AcpChild, force = false) {
    this.forget(JSON.stringify([child.owner, child.agent.name]), child)
    await child.close(force)
  }

  close() {
    if (this.closing) return this.closing
    this.closing = (async () => {
      await Promise.allSettled([...this.children.values()].map((child) => this.retire(child)))
      if (!this.options.storage) await rm(this.storage, { recursive: true, force: true })
    })()
    return this.closing
  }
}

/** Legacy command-array factory. Service integrations should own an AcpClient and close it on shutdown. */
export function acpTool(config: string) {
  const client = new AcpClient(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(config))
  const tool = client.tool()
  if (!tool) throw new Error("Configure an enabled ACP agent.")
  return { ...tool, close: () => client.close(), [Symbol.asyncDispose]: () => client.close() }
}
