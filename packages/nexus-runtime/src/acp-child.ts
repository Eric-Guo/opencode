import {
  client,
  ndJsonStream,
  RequestError,
  type ClientConnection,
  type InitializeResponse,
  type PromptResponse,
  type SessionNotification,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import crossSpawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import { Writable, Readable } from "node:stream"
import { resolve } from "node:path"
import { Schema } from "effect"
import type { JsonObject } from "@cybros/agent"
import type { RunnerContext } from "./extensions"
import { AcpCapture, within } from "./acp-capture"
import { acpEnvironment, acpExecutable, type AcpAgent } from "./acp-settings"
import { acpPermission } from "./acp-policy"
import { ClaimDeadline } from "./claim-control"

export class AcpTimeout extends Error {}
export type AcpSession = {
  id: string
  remote: string
  cwd: string
  owner: string
  calls: number
  opened: string
  last_prompt: string | null
  tools: Map<string, ToolCallUpdate>
}
type Call = {
  session: AcpSession
  context: RunnerContext
  text: string
  message?: string | null
  calls: number
  refused: number
  asks: string[]
  usage: JsonObject | null
  canceled: boolean
  pending: boolean
}

export class AcpChild {
  private process?: ChildProcess
  private connection?: ClientConnection
  private initialization?: InitializeResponse
  private queue = Promise.resolve()
  private current?: Call
  private readonly death = Promise.withResolvers<never>()
  private readonly ended = Promise.withResolvers<void>()
  private closing?: Promise<void>
  private stderr = ""
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private authenticated = false
  readonly sessions = new Map<string, AcpSession>()
  retired = false

  constructor(
    readonly agent: AcpAgent,
    readonly owner: string,
    readonly capture: AcpCapture,
    private readonly protectedRoots: readonly string[],
  ) {
    void this.death.promise.catch(() => {})
  }

  get alive() {
    return !this.retired && !this.exit && !this.connection?.signal.aborted
  }
  get pid() {
    return this.process?.pid ?? null
  }
  get busy() {
    return !!this.current?.pending
  }
  get closed() {
    return this.ended.promise
  }

  serial<A>(signal: AbortSignal, run: () => Promise<A>) {
    const state = { entered: false }
    const pending = this.queue.then(async () => {
      signal.throwIfAborted()
      if (this.retired) throw new Error("This delegated child has retired; omit session to start a new one.")
      if (this.current?.canceled && this.current.pending)
        throw new Error("The agent is still finishing its canceled delegation; retry when it finishes.")
      state.entered = true
      return run()
    })
    this.queue = pending.then(
      () => {},
      () => {},
    )
    return new Promise<A>((resolve, reject) => {
      const abort = () => {
        if (!state.entered) reject(signal.reason)
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
  }

  async start(cwd: string, signal: AbortSignal) {
    if (this.initialization) return this.initialization
    const executable = await acpExecutable(this.agent, cwd)
    signal.throwIfAborted()
    if (this.retired) throw new Error("This delegated child has retired.")
    const child = crossSpawn(executable ?? this.agent.command, [...this.agent.args], {
      cwd,
      env: acpEnvironment(this.agent),
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    this.process = child
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4096)
    })
    child.once("error", (error) => this.died(null, null, error.message))
    child.once("close", (code, reason) => this.died(code, reason))
    this.connection = client({ name: "OpenCode Nexus" })
      .onNotification("session/update", ({ params }) => this.update(params))
      .onRequest("session/request_permission", async ({ params }) => {
        const call = this.current
        if (!call || call.canceled || params.sessionId !== call.session.remote)
          return { outcome: { outcome: "cancelled" } }
        const decision = await acpPermission(
          params,
          call.session.tools.get(params.toolCall.toolCallId),
          this.agent,
          call.session.cwd,
          this.protectedRoots,
          call.context,
        ).catch(() => ({ response: { outcome: { outcome: "cancelled" as const } }, refused: false }))
        if (call.canceled || this.current !== call) return { outcome: { outcome: "cancelled" } }
        if (decision.refused) call.refused++
        this.capture.record("note", {
          event: "permission",
          session: call.session.id,
          tool: params.toolCall.toolCallId,
          floor_refused: decision.refused,
          result: decision.response,
        })
        return decision.response
      })
      .onRequest("elicitation/create", ({ params }) => {
        if (
          this.current &&
          !this.current.canceled &&
          "sessionId" in params &&
          params.sessionId === this.current.session.remote
        )
          this.current.asks.push(params.message)
        return { action: "decline" }
      })
      .connect(
        this.capture.stream(
          ndJsonStream(
            Writable.toWeb(child.stdin!),
            Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
            { maxMessageBytes: 8 * 1024 * 1024 },
          ),
        ),
      )
    this.capture.record("note", { event: "spawned", agent: this.agent.name, pid: child.pid, cwd })
    const result = await this.request(
      this.connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} }),
      signal,
    )
    if (result.protocolVersion !== 1) throw new Error("acp_version: this client requires ACP protocol version 1.")
    this.initialization = result
    return result
  }

  async open(cwd: string, signal: AbortSignal) {
    const connection = this.connection!
    const result = await this.request(connection.agent.request("session/new", { cwd, mcpServers: [] }), signal).catch(
      async (error: unknown) => {
        if (!(error instanceof RequestError && error.code === -32000)) throw error
        if (this.authenticated) throw new Error(this.authRequired())
        const methods =
          this.initialization?.authMethods?.filter((method) => !("type" in method && method.type === "terminal")) ?? []
        const method = this.agent.auth_method
          ? methods.find((entry) => entry.id === this.agent.auth_method)
          : methods.length === 1
            ? methods[0]
            : undefined
        if (!method) throw new Error(this.authRequired())
        await this.request(connection.agent.request("authenticate", { methodId: method.id }), signal)
        this.authenticated = true
        return this.request(connection.agent.request("session/new", { cwd, mcpServers: [] }), signal)
      },
    )
    const model = result.configOptions?.find((option) => option.category === "model" && option.type === "select")
    if (this.agent.model && model)
      await this.request(
        connection.agent.request("session/set_config_option", {
          sessionId: result.sessionId,
          configId: model.id,
          value: this.agent.model,
        }),
        signal,
      )
    return result.sessionId
  }

  async prompt(session: AcpSession, prompt: string, context: RunnerContext, signal: AbortSignal) {
    const call: Call = {
      session,
      context,
      text: "",
      calls: 0,
      refused: 0,
      asks: [],
      usage: null,
      canceled: false,
      pending: true,
    }
    this.current = call
    session.calls++
    session.last_prompt = new Date().toISOString()
    const pending = this.connection!.agent.request("session/prompt", {
      sessionId: session.remote,
      prompt: [{ type: "text", text: prompt }],
    })
    void pending
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        call.pending = false
        if (this.current === call) this.current = undefined
      })
    try {
      const response = await this.request(pending, signal)
      return this.reply(call, response)
    } catch (error) {
      if (signal.aborted) {
        call.canceled = true
        await this.cancel(session.remote)
        if (signal.reason instanceof AcpTimeout || signal.reason instanceof ClaimDeadline) {
          await this.close(true)
          return {
            ...this.reply(call, { stopReason: "cancelled" }),
            text: this.capture.redact(
              'ACP agent "' + this.agent.name + '" timed out; its process group was terminated.\n' + call.text,
            ),
            stop: "timed_out",
            error: true,
          }
        }
        throw signal.reason
      }
      return {
        ...this.reply(call, { stopReason: "cancelled" }),
        stop: this.exit ? "exited" : "refused",
        error: true,
        text: this.capture.redact(this.describe(error)),
      }
    }
  }

  private async cancel(session: string) {
    this.capture.record("note", { event: "cancel_requested", session })
    if (this.connection)
      await within(
        this.connection.agent.notify("session/cancel", { sessionId: session }),
        AbortSignal.timeout(250),
      ).catch(() => {})
  }

  private reply(call: Call, response: PromptResponse) {
    return {
      text: this.capture.redact(call.text),
      stop: response.stopReason as string,
      error: !["end_turn", "max_tokens"].includes(response.stopReason),
      calls: call.calls,
      refused: call.refused,
      usage: call.usage,
      asks: call.asks.map((text) => this.capture.redact(text)),
    }
  }

  private update(notification: SessionNotification) {
    const call = this.current
    if (!call || call.canceled || notification.sessionId !== call.session.remote) return
    const update = notification.update
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      if (call.message != null && call.message !== update.messageId && call.text && !call.text.endsWith("\n"))
        call.text += "\n"
      call.message = update.messageId
      call.text = (call.text + update.content.text).slice(0, 65536)
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const previous = call.session.tools.get(update.toolCallId)
      call.session.tools.set(update.toolCallId, {
        ...previous,
        ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)),
        toolCallId: update.toolCallId,
      })
      if (update.sessionUpdate === "tool_call") call.calls++
    }
    if (update.sessionUpdate === "usage_update")
      call.usage = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)))(
        JSON.stringify(update),
      )
  }

  private request<A>(pending: Promise<A>, signal: AbortSignal) {
    return within(Promise.race([pending, this.death.promise]), signal)
  }

  private authRequired() {
    return (
      "acp_auth_required: run this agent's own login, then probe it. Available methods: " +
      (this.initialization?.authMethods
        ?.map((method) => method.id + ("type" in method && method.type === "terminal" ? " (terminal)" : " (agent)"))
        .join(", ") || "none")
    )
  }

  private died(code: number | null, signal: NodeJS.Signals | null, message?: string) {
    if (this.exit) return
    this.exit = { code, signal }
    this.death.reject(new Error(this.describe(message)))
    this.ended.resolve()
  }

  describe(error?: unknown) {
    return (
      'ACP agent "' +
      this.agent.name +
      '" ' +
      (this.exit ? "exited (" + (this.exit.signal ?? this.exit.code ?? "unknown") + ")" : "refused the operation") +
      (error ? ": " + (error instanceof Error ? error.message : String(error)) : "") +
      (this.stderr ? "; stderr: " + this.stderr.trim() : "")
    )
  }

  close(force = false) {
    if (this.closing) return this.closing
    this.retired = true
    this.closing = (async () => {
      if (!this.process) {
        this.ended.resolve()
        return
      }
      if (!force && this.connection && !this.connection.signal.aborted && !this.busy)
        await Promise.allSettled(
          [...this.sessions.values()].map((session) =>
            within(
              this.connection!.agent.request("session/close", { sessionId: session.remote }),
              AbortSignal.timeout(500),
            ),
          ),
        )
      this.connection?.close()
      this.process.stdin?.end()
      this.signal(force ? "SIGKILL" : "SIGTERM")
      await within(this.ended.promise, AbortSignal.timeout(1500)).catch(async () => {
        this.signal("SIGKILL")
        await within(this.ended.promise, AbortSignal.timeout(1500)).catch(() => {})
      })
      this.capture.record("note", { event: "retired", force })
    })()
    return this.closing
  }

  private signal(signal: NodeJS.Signals) {
    if (!this.process?.pid || this.exit) return
    if (process.platform === "win32") {
      crossSpawn(
        resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(this.process.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      ).on("error", () => {})
      return
    }
    try {
      process.kill(-this.process.pid, signal)
    } catch {
      this.process.kill(signal)
    }
  }
}
