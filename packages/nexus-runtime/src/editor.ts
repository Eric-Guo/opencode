import { executionSnapshot, repairTaskKey } from "./execution"
export { authenticateEditorTerminal } from "./editor-auth"

import {
  agent,
  RequestError,
  type AgentContext,
  type ClientCapabilities,
  type ContentBlock,
  type McpServer,
  type SessionConfigOption,
  type Stream,
} from "@agentclientprotocol/sdk"
import {
  Client,
  type ExecutionDecision,
  type InputExecution,
  type JsonObject,
  type Model,
  type Turn,
} from "@cybros/agent"
import { setImmediate, setTimeout } from "node:timers/promises"
import { Schema } from "effect"
import type { Status } from "./runtime"
import { authenticateEditor, type EditorAuthentication } from "./editor-auth"
import type { Nexus } from "@opencode/schema/nexus"
import { editorBridge, editorRoots, localEditorRoots } from "./editor-bridge"
import { EditorTranscript, editorCall } from "./editor-follow"
import { readEditorHistory } from "./editor-replay"

type Mode = "bypass" | "ask" | "rules"
type EditorPort = ReturnType<Awaited<ReturnType<typeof editorBridge>>["attach"]>
type Session = {
  roots: string[]
  mode: Mode
  model?: string
  code: boolean
  codeAvailable: boolean
  own: boolean
  local: boolean
  mountedMcp: boolean
  last?: { execution: InputExecution; transcript: EditorTranscript }
  question?: { decision: ExecutionDecision; execution: InputExecution; transcript: EditorTranscript }
}
export type EditorOptions = {
  open?: (environment: Nexus.EnvironmentRoots) => Promise<string>
  defaults?: { mode?: Mode; model?: string }
  submit?: (
    input: {
      conversation: string
      key: string
      text: string
      attachments?: readonly string[]
      model?: string
      approval: Mode
      addressed?: boolean
      answering_user_public_id?: string
    },
    signal: AbortSignal,
  ) => Promise<string>
  skills?: (signal?: AbortSignal) => Promise<readonly { name: string; description: string }[]>
  approve?: (
    input: { conversation: string; run: string; task: string; always: boolean },
    signal: AbortSignal,
  ) => Promise<{ grant?: { refused?: string } }>

  authentication?: EditorAuthentication
  setEnvironment?: (conversation: string, binding: EditorPort | null) => Promise<void>
  bindRoots?: (conversation: string, roots: string[]) => Promise<void>
  modePolicy?: (
    conversation: string,
  ) => Promise<{ available?: boolean; code_mode_available?: boolean; code_mode: boolean }>
  codeMode?: (conversation: string) => Promise<boolean>
  setCodeMode?: (conversation: string, enabled: boolean) => Promise<void>
  attachMcp?: (input: {
    conversation: string
    cwd: string
    servers: readonly McpServer[]
  }) => Promise<{ tools: readonly string[]; issues: readonly string[] }>
  detachMcp?: (conversation: string) => Promise<void>
}

export async function editor(stream: Stream, status: Status, token: string, options: EditorOptions = {}) {
  const credentialProvider = async () => {
    const credential = token || (await options.authentication?.credential())

    if (!credential) throw RequestError.authRequired(undefined, "Authenticate with Nexus first.")

    return credential
  }
  const nexus = {
    status,
    client: new Client({ baseURL: status.origin || "http://127.0.0.1", credentialProvider }),
    get identity() {
      return this.status.identity
    },
    get workspace() {
      return this.client.workspace(this.identity?.workspace ?? "unpaired")
    },
  }
  const sessions = new Map<string, Session>()
  const pending = new Map<string, AbortController>()
  const state: { authenticated: boolean; capabilities: ClientCapabilities; models: Model[] } = {
    authenticated: false,
    capabilities: {},
    models: [],
  }
  const bridge = await editorBridge()
  const authenticate = async (signal: AbortSignal, peer?: AgentContext, requestId: string | number | null = null) => {
    if (state.authenticated) return
    if (options.authentication) {
      nexus.status =
        peer && !token
          ? await authenticateEditor(options.authentication, peer, state.capabilities, signal, requestId)
          : await options.authentication.status()
      nexus.client = new Client({ baseURL: nexus.status.origin, credentialProvider })
    }
    if (nexus.status.state !== "ready" || !nexus.identity)
      throw RequestError.authRequired({ authMethods: ["nexus"] }, "Connect OpenCode to Nexus with authenticate.")
    if ((await nexus.client.profile.fetch({ signal })).member.kind !== "human")
      throw RequestError.authRequired(undefined, "A Human member token is required.")

    await nexus.workspace.fetch({ signal })
    state.models = await nexus.client.models.list({ workload: "text_generation" }, { signal })
    state.authenticated = true
  }

  const requireSession = (id: string) => {
    const session = sessions.get(id)

    if (!session) throw RequestError.resourceNotFound(id)

    return session
  }
  const projection = (id: string, peer: AgentContext) =>
    new EditorTranscript(id, peer, requireSession(id).roots[0], (run, task) =>
      nexus.workspace
        .run(run)
        .task(task)
        .fetch({ signal: pending.get(id)?.signal }),
    )
  const remember = (id: string, session: Session, turn: Turn | undefined, peer: AgentContext) => {
    if (!turn || turn.role !== "assistant" || turn.reference || turn.inherited || turn.kind === "compaction_summary")
      return

    const variant = turn.running_variant ?? turn.active_variant

    if (!variant?.run_public_id) return

    session.last = {
      execution: nexus.workspace.conversation(id).execution({
        turn_public_id: turn.public_id,
        variant_public_id: variant.public_id,
        run_public_id: variant.run_public_id,
      }),
      transcript: projection(id, peer),
    }
  }
  const catchUp = async (
    execution: InputExecution,
    moved: (snapshot: NonNullable<InputExecution["snapshot"]>) => boolean,
    signal: AbortSignal,
  ) => {
    const deadline = performance.now() + 5000

    while (!signal.aborted) {
      const snapshot = await execution.recover({ signal }).then(executionSnapshot)

      if (!snapshot || moved(snapshot) || performance.now() >= deadline) return

      await setTimeout(250, undefined, { signal })
    }

    signal.throwIfAborted()
  }
  const answered = (execution: InputExecution, decision: ExecutionDecision, signal: AbortSignal) =>
    catchUp(
      execution,
      (snapshot) =>
        snapshot.attention?.reason !== "awaiting_human" ||
        !snapshot.attention.blocked_task_keys.includes(decision.detail.task.key),
      signal,
    )

  const follow = async (
    id: string,
    session: Session,
    execution: InputExecution,
    transcript: EditorTranscript,
    peer: AgentContext,
    signal: AbortSignal,
  ) => {
    const streaming = new AbortController()
    let watcher: Promise<void> | undefined
    const dismissed = new Set<string>()

    try {
      while (!signal.aborted) {
        const snapshot = await execution.recover({ signal }).then(executionSnapshot)

        if (execution.blocked_reason)
          throw RequestError.invalidParams(undefined, "Nexus blocked the input (" + execution.blocked_reason + ").")
        if (snapshot) transcript.execution(snapshot.execution)
        if (snapshot && !watcher) {
          watcher = (async () => {
            const { RealtimeClient } = await import("@cybros/agent/realtime")
            const realtime = new RealtimeClient({
              baseURL: nexus.status.origin,
              credentialProvider,
              timeoutMs: 5000,
            })

            try {
              const options = { signal: AbortSignal.any([signal, streaming.signal]) }

              const watch = async (subscribe: () => Promise<void>) => {
                while (!options.signal.aborted) {
                  await subscribe().catch(() => {})
                  if (!options.signal.aborted) await setTimeout(1000, undefined, options)
                }
              }
              await Promise.allSettled([
                watch(async () => {
                  for await (const frame of await realtime.conversationTranscript(
                    nexus.identity!.workspace,
                    id,
                    options,
                  ))
                    await transcript.frame(frame)
                }),
                watch(async () => {
                  for await (const frame of await realtime.conversationProgress(nexus.identity!.workspace, id, options))
                    await transcript.progress(frame)
                }),
              ])
            } finally {
              await realtime.close()
            }
          })().catch(() => {})
        }
        if (snapshot?.execution.run_public_id) {
          const run = snapshot.execution.run_public_id
          const rows = await nexus.workspace.run(run).transcript({ limit: 100 }, { signal })

          for (const round of rows.rounds.filter((round) => round.mainline))
            for (const call of round.calls.items) await transcript.call(run, call)
        }
        if (snapshot?.terminal) {
          streaming.abort()
          await watcher
          await transcript.settle(snapshot.content ?? "")
          if (["failed", "timed_out", "uncertain"].includes(snapshot.status ?? "") || snapshot.failure_reason)
            throw new RequestError(-32603, snapshot.failure_reason ?? "Nexus execution failed", {
              run: snapshot.execution.run_public_id,
              reason: snapshot.failure_reason_key,
            })

          return { stopReason: snapshot.status === "canceled" ? ("cancelled" as const) : ("end_turn" as const) }
        }
        if (snapshot?.status === "failed")
          throw new RequestError(-32603, snapshot.failure_reason ?? "The Nexus execution is holding.", {
            hold: true,
            run_public_id: snapshot.execution.run_public_id,
            retry: "/retry",
            abandon: "/abandon",
          })
        if (snapshot?.execution.run_public_id)
          for (const decision of await execution.decisions({ signal })) {
            if (decision.kind === "ask") {
              if (state.capabilities.elicitation?.form) {
                const response = await peer.request(
                  "elicitation/create",
                  {
                    mode: "form",
                    sessionId: id,
                    message: decision.detail.prompt ?? "Answer requested.",
                    requestedSchema: {
                      type: "object",
                      properties: {
                        answer: {
                          type: "string",
                          ...(decision.detail.options ? { enum: decision.detail.options } : {}),
                        },
                      },
                      required: ["answer"],
                    },
                  },
                  { cancellationSignal: signal },
                )

                if (response.action === "accept") {
                  await decision.task.resolve(
                    {
                      content:
                        Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(
                          response.content ?? {},
                        ).answer ?? "",
                    },
                    { signal },
                  )
                  session.question = undefined
                  await answered(execution, decision, signal)
                  continue
                }
                if (response.action === "decline") {
                  await decision.task.resolve(
                    { outcome: "failed", content: "The user declined the question." },
                    { signal },
                  )
                  session.question = undefined
                  await answered(execution, decision, signal)
                  continue
                }
              }

              session.question = { decision, execution, transcript }
              return { stopReason: "end_turn" as const, question: decision.detail.prompt ?? "Answer requested." }
            }

            const task = decision.detail.task
            const key = snapshot.execution.run_public_id + ":" + task.key

            if (dismissed.has(key)) continue

            await transcript.call(
              snapshot.execution.run_public_id,
              { task_key: task.key, status: task.status },
              decision.detail,
            )
            const response = await peer
              .request(
                "session/request_permission",
                {
                  sessionId: id,
                  toolCall: {
                    toolCallId: key,
                    ...editorCall(task.key, decision.detail),
                  },
                  options: [
                    { optionId: "approve", name: "Allow once", kind: "allow_once" },
                    ...(options.approve && session.own
                      ? [
                          {
                            optionId: "always",
                            name:
                              task.tool_name === "web_fetch" && task.target?.kind !== "mcp"
                                ? "Allow this site until OpenCode restarts"
                                : task.target?.kind === "mcp"
                                  ? "Always allow this tool until OpenCode restarts"
                                  : "Allow this call's scope until OpenCode restarts",
                            kind: "allow_always" as const,
                          },
                        ]
                      : []),
                    { optionId: "deny", name: "Deny", kind: "reject_once" },
                  ],
                },
                { cancellationSignal: signal },
              )
              .catch(async (error: unknown) => {
                signal.throwIfAborted()
                // A client that abandons its permission request has declined this call.
                await decision.task.deny("The editor client went away.", { signal })
                if (error instanceof RequestError && error.code === -32800) return

                throw error
              })

            if (signal.aborted) break
            if (!response) continue
            if (response.outcome.outcome === "cancelled") {
              dismissed.add(key)
              continue
            }
            if (
              response.outcome.outcome === "selected" &&
              (response.outcome.optionId === "approve" ||
                (session.own && options.approve && response.outcome.optionId === "always"))
            ) {
              if (options.approve) {
                const result = await options.approve(
                  {
                    conversation: id,
                    run: snapshot.execution.run_public_id,
                    task: task.key,
                    always: response.outcome.optionId === "always",
                  },
                  signal,
                )

                if (result.grant?.refused)
                  await transcript.question("Approved this call. The grant could not be saved: " + result.grant.refused)
              } else await decision.task.approve({ signal })
            } else await decision.task.deny(undefined, { signal })
          }

        await setTimeout(500, undefined, { signal })
      }

      return { stopReason: "cancelled" as const }
    } catch (error) {
      if (signal.aborted) return { stopReason: "cancelled" as const }

      throw error
    } finally {
      streaming.abort()
      await watcher
    }
  }
  const background = new Set<Promise<void>>()
  const restoreQuestion = (id: string, session: Session, peer: AgentContext) => {
    const question = session.question

    if (!question) return

    const owner = new AbortController()

    pending.set(id, owner)
    // Start after the load/resume response, so an editor may first display the restored session.
    const task = setTimeout(0, undefined, { signal: owner.signal })
      .then(async () => {
        const text = state.capabilities.elicitation?.form
          ? (await follow(id, session, question.execution, question.transcript, peer, owner.signal)).question
          : (question.decision.detail.prompt ?? "Answer requested.")

        if (text === undefined || owner.signal.aborted || pending.get(id) !== owner) return

        // The editor can answer as soon as it receives the question.
        pending.delete(id)
        await question.transcript.question(text)
      })
      .catch(async (error: unknown) => {
        if (owner.signal.aborted) return

        await question.transcript.question(error instanceof Error ? error.message : String(error)).catch(() => {})
      })
      .finally(() => {
        if (pending.get(id) === owner) pending.delete(id)
        background.delete(task)
      })

    background.add(task)
  }
  const config = (session: Session): SessionConfigOption[] => [
    {
      id: "mode",
      name: "Approval mode",
      category: "mode",
      type: "select",
      currentValue: session.mode,
      options: modes.map((mode) => ({ value: mode.id, name: mode.name })),
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.model ?? nexus.status.model,
      options: [
        ...new Set([
          session.model ?? nexus.status.model,
          nexus.status.model,
          ...state.models.filter((model) => model.available && model.visible).map((model) => model.ref),
        ]),
      ].map((value) => ({ value, name: value })),
    },
    ...(options.setCodeMode && session.codeAvailable
      ? [
          {
            id: "code_mode",
            name: "Code mode",
            type: "select" as const,
            currentValue: session.code ? "on" : "off",
            options: [
              { value: "on", name: "On" },
              { value: "off", name: "Off" },
            ],
          },
        ]
      : []),
  ]
  const attach = async (
    id: string,
    paths: string[],
    servers: readonly McpServer[],
    peer: AgentContext,
    signal: AbortSignal,
    replay: boolean,
  ) => {
    if (pending.has(id)) throw RequestError.invalidRequest(undefined, "The editor session is busy.")

    const conversation = await nexus.workspace.conversation(id).fetch({ signal })

    if (conversation.archived_at) throw RequestError.resourceNotFound(id)

    const own = conversation.answering_user_public_id === nexus.identity?.agent
    const local = conversation.default_runner?.executor_public_id === nexus.identity?.runner
    const roots = local ? await localEditorRoots(paths) : paths
    await (local
      ? options.setEnvironment?.(id, bridge.attach(id, roots, peer, state.capabilities))
      : options.bindRoots?.(id, roots))
    const policy = own
      ? await options.modePolicy?.(id)
      : { available: false, code_mode_available: false, code_mode: false }
    const saved = conversation.metadata["opencode.acp.mode"]
    const canMount = own || local
    const mcp =
      canMount && servers.length ? await options.attachMcp?.({ conversation: id, cwd: roots[0], servers }) : undefined
    const issues =
      mcp?.issues ?? (servers.length ? ["This agent cannot serve editor MCP tools for this conversation."] : [])
    const session: Session = {
      roots,
      own,
      local,
      codeAvailable:
        own && (policy ? policy.available === true && policy.code_mode_available === true : !!options.setCodeMode),
      mode: saved === "bypass" || saved === "rules" ? saved : "ask",
      model:
        typeof conversation.metadata["opencode.acp.model"] === "string"
          ? conversation.metadata["opencode.acp.model"]
          : undefined,
      code:
        policy?.code_mode ??
        (options.codeMode ? await options.codeMode(id) : conversation.metadata["opencode.acp.code"] !== false),
      mountedMcp: !!mcp || sessions.get(id)?.mountedMcp === true,
    }

    sessions.set(id, session)
    remember(
      id,
      session,
      replay
        ? await readEditorHistory(nexus.workspace, id, signal, { peer, root: roots[0] })
        : conversation.active_turn_public_id
          ? await nexus.workspace
              .conversation(id)
              .turns.fetch(conversation.active_turn_public_id, undefined, { signal })
          : undefined,
      peer,
    )
    if (session.last) {
      const decision = (await session.last.execution.decisions({ signal })).find((decision) => decision.kind === "ask")

      if (decision)
        session.question = {
          decision,
          ...session.last,
        }
    }

    void announceCommands(id, session, peer, connection.signal).catch(() => {})
    restoreQuestion(id, session, peer)
    return {
      modes: { currentModeId: session.mode, availableModes: modes },
      configOptions: config(session),
      ...(issues?.length ? { _meta: { "opencode.mcp.issues": issues } } : {}),
    }
  }
  async function announceCommands(id: string, session: Session, peer: AgentContext, signal: AbortSignal) {
    // The SDK queues the attach response when its handler returns. Editors need the session ID first.
    await setImmediate(undefined, { signal })
    if (sessions.get(id) !== session) return

    const skills = (await options.skills?.(signal).catch(() => [])) ?? []
    if (signal.aborted || sessions.get(id) !== session) return

    await peer.notify("session/update", {
      sessionId: id,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "retry", description: "Retry the holding task." },
          { name: "abandon", description: "Abandon the holding task." },
          { name: "compact", description: "Compact this conversation." },
          ...skills.filter((skill) => !["retry", "abandon", "compact"].includes(skill.name)),
        ],
      },
    })
  }
  const save = async (id: string, patch: JsonObject, signal: AbortSignal) => {
    const chat = nexus.workspace.conversation(id)
    const conversation = await chat.fetch({ signal })

    await chat.update(
      { lock_version: conversation.lock_version, metadata: { ...conversation.metadata, ...patch } },
      { signal },
    )
  }
  const app = agent({ name: "OpenCode Nexus" })
    .onRequest("initialize", ({ params }) => {
      state.capabilities = params.clientCapabilities ?? {}

      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          ...(options.attachMcp ? { mcpCapabilities: { http: true, sse: false } } : {}),
          sessionCapabilities: { resume: {}, close: {}, additionalDirectories: {} },
        },
        authMethods: [
          { id: "nexus", name: "Connect to Nexus", description: "Open the Nexus device or sign-in page." },
          ...(options.authentication && state.capabilities.auth?.terminal
            ? [
                {
                  id: "connect",
                  type: "terminal" as const,
                  name: "Connect from the terminal",
                  env: { OPENCODE_NEXUS_ACP_AUTH: "1" },
                },
              ]
            : []),
        ],
        agentInfo: { name: "OpenCode Nexus", version: "1" },
      }
    })
    .onRequest("authenticate", async ({ params, signal, client: peer, requestId }) => {
      if (params.methodId !== "nexus") throw RequestError.invalidParams(undefined, "Unknown authentication method.")

      await authenticate(signal, peer, requestId)
      return {}
    })
    .onRequest("session/new", async ({ params, signal, client: peer }) => {
      await authenticate(signal)
      const paths = editorRoots(params.cwd, params.additionalDirectories)
      const roots = options.open ? paths : await localEditorRoots(paths)

      validateServers(params.mcpServers)

      const result = options.open
        ? { conversation: { public_id: await options.open({ root: roots[0], directories: roots.slice(1) }) } }
        : await nexus.workspace.conversations.create(
            {
              answering_user_public_id: nexus.identity!.agent,
              default_runner_executor_public_id: nexus.identity!.runner,
              metadata: { "opencode.surface": "acp", "opencode.acp.cwd": roots[0] },
            },
            { signal, idempotencyKey: crypto.randomUUID() },
          )
      const id = result.conversation.public_id

      await save(
        id,
        {
          "opencode.surface": "acp",
          "opencode.acp.cwd": roots[0],
          ...(options.defaults?.mode ? { "opencode.acp.mode": options.defaults.mode } : {}),
          ...(options.defaults?.model ? { "opencode.acp.model": options.defaults.model } : {}),
        },
        signal,
      )

      return { sessionId: id, ...(await attach(id, roots, params.mcpServers, peer, signal, false)) }
    })
    .onRequest("session/load", async ({ params, signal, client: peer }) => {
      await authenticate(signal)
      validateServers(params.mcpServers)

      return attach(
        params.sessionId,
        editorRoots(params.cwd, params.additionalDirectories),
        params.mcpServers,
        peer,
        signal,
        true,
      )
    })
    .onRequest("session/resume", async ({ params, signal, client: peer }) => {
      await authenticate(signal)
      validateServers(params.mcpServers ?? [])

      return attach(
        params.sessionId,
        editorRoots(params.cwd, params.additionalDirectories),
        params.mcpServers ?? [],
        peer,
        signal,
        false,
      )
    })
    .onRequest("session/close", async ({ params }) => {
      const session = requireSession(params.sessionId)
      pending.get(params.sessionId)?.abort()
      sessions.delete(params.sessionId)
      bridge.release(params.sessionId)
      if (session.mountedMcp) await options.detachMcp?.(params.sessionId)
      if (session.local) await options.setEnvironment?.(params.sessionId, null)
      return {}
    })
    .onRequest("session/set_mode", async ({ params, signal, client: peer }) => {
      const session = requireSession(params.sessionId)

      if (!modes.some((mode) => mode.id === params.modeId))
        throw RequestError.invalidParams(undefined, "Unknown approval mode.")

      await save(params.sessionId, { "opencode.acp.mode": params.modeId }, signal)
      session.mode = params.modeId as Mode
      await peer.notify("session/update", {
        sessionId: params.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: session.mode },
      })
      return {}
    })
    .onRequest("session/set_config_option", async ({ params, signal, client: peer }) => {
      const session = requireSession(params.sessionId)

      if (
        params.configId === "mode" &&
        typeof params.value === "string" &&
        modes.some((mode) => mode.id === params.value)
      ) {
        await save(params.sessionId, { "opencode.acp.mode": params.value }, signal)
        session.mode = params.value as Mode
      } else if (params.configId === "model" && typeof params.value === "string") {
        const models = await nexus.client.models.list({ workload: "text_generation" }, { signal })

        if (
          params.value !== nexus.status.model &&
          !models.some((model) => model.ref === params.value && model.available)
        )
          throw RequestError.invalidParams(undefined, "Unknown or unavailable model.")

        await save(params.sessionId, { "opencode.acp.model": params.value }, signal)
        state.models = models
        session.model = params.value
      } else if (
        params.configId === "code_mode" &&
        options.setCodeMode &&
        session.codeAvailable &&
        ["on", "off", true, false].includes(params.value)
      ) {
        const enabled = params.value === true || params.value === "on"

        await options.setCodeMode(params.sessionId, enabled)
        await save(params.sessionId, { "opencode.acp.code": enabled }, signal)
        session.code = enabled
      } else throw RequestError.invalidParams(undefined, "Unknown session configuration option or value.")

      const configOptions = config(session)

      await peer.notify("session/update", {
        sessionId: params.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions },
      })
      return { configOptions }
    })
    .onNotification("session/cancel", async ({ params }) => {
      if (!sessions.has(params.sessionId)) return

      pending.get(params.sessionId)?.abort()
      sessions.get(params.sessionId)!.question = undefined
      await nexus.workspace
        .conversation(params.sessionId)
        .cancel()
        .catch(() => {})
    })
    .onRequest("session/prompt", async (ctx) => {
      const id = ctx.params.sessionId
      const session = requireSession(id)

      if (pending.has(id)) throw RequestError.invalidRequest(undefined, "The editor session is busy.")

      const owner = new AbortController()
      const signal = AbortSignal.any([owner.signal, ctx.signal])
      const chat = nexus.workspace.conversation(id)
      pending.set(id, owner)
      try {
        const prompt = await editorPrompt(
          ctx.params.prompt,
          nexus.client,
          signal,
          (text) => !session.question && !surfaceCommand(text),
        )
        const command = surfaceCommand(prompt.text)

        if (command === "compact") {
          await chat.compact(undefined, { signal })
          return { stopReason: "end_turn" as const }
        }
        if (command === "retry" || command === "abandon") {
          if (!session.last) remember(id, session, await readEditorHistory(nexus.workspace, id, signal), ctx.client)

          const snapshot = await session.last?.execution.recover({ signal }).then(executionSnapshot)
          const runID = snapshot?.execution.run_public_id

          if (!runID) throw new RequestError(-32603, "There is no holding task in this editor session.")

          const run = nexus.workspace.run(runID)
          const task = run.task(repairTaskKey(await run.fetch({ signal })))

          if (command === "abandon") {
            await task.abandon({ signal })
            return { stopReason: "end_turn" as const }
          }

          await task.retry(undefined, { signal })
          await catchUp(session.last!.execution, (snapshot) => snapshot.status !== "failed", signal)
        }

        const question = command ? undefined : session.question
        const transcript =
          command === "retry" ? session.last!.transcript : (question?.transcript ?? projection(id, ctx.client))
        const execution =
          command === "retry"
            ? session.last!.execution
            : question
              ? question.execution
              : await (async () => {
                  if (!options.submit) throw new Error("The editor requires shared application admission.")

                  const input = await options.submit(
                    {
                      conversation: id,
                      key: crypto.randomUUID(),
                      ...prompt,
                      model: session.model,
                      approval: session.mode,
                      ...(!session.own
                        ? {
                            addressed: true,
                            answering_user_public_id: (await chat.fetch({ signal })).answering_user_public_id,
                          }
                        : {}),
                    },
                    signal,
                  )

                  return chat.inputExecution(input)
                })()

        session.last = { execution, transcript }

        if (question) {
          await question.decision.task.resolve({ content: prompt.text }, { signal })
          session.question = undefined
          await answered(execution, question.decision, signal)
        }

        const result = await follow(id, session, execution, transcript, ctx.client, signal)

        if (result.question !== undefined) {
          signal.throwIfAborted()
          await transcript.question(result.question)
        }

        return { stopReason: result.stopReason }
      } catch (error) {
        if (signal.aborted) return { stopReason: "cancelled" as const }

        throw error
      } finally {
        if (pending.get(id) === owner) pending.delete(id)
      }
    })
  const connection = app.connect(stream)

  try {
    await connection.closed
  } finally {
    for (const owner of pending.values()) owner.abort()
    await bridge.close()
    await Promise.allSettled(background)
    await Promise.allSettled(
      [...sessions].flatMap(([id, session]) => [
        session.mountedMcp && options.detachMcp?.(id),
        session.local && options.setEnvironment?.(id, null),
      ]),
    )
  }
}

function validateServers(servers: readonly McpServer[]) {
  if (new Set(servers.map((server) => server.name)).size !== servers.length)
    throw RequestError.invalidParams(undefined, "Duplicate MCP server names.")
}

const modes = [
  { id: "bypass", name: "Bypass", description: "Run tools without approval prompts." },
  { id: "ask", name: "Ask", description: "Ask before operations requiring approval." },
  { id: "rules", name: "Rules", description: "Apply the configured approval rules." },
]

function surfaceCommand(text: string) {
  return /^\/(retry|abandon|compact)(?:\s|$)/.exec(text)?.[1]
}

export async function editorPrompt(
  parts: readonly ContentBlock[],
  client: Client,
  signal: AbortSignal,
  acceptsPDF?: (text: string) => boolean,
) {
  const text: string[] = []
  const files: File[] = []
  const attachments: string[] = []
  const maxBytes = 16 * 1024 * 1024

  for (const part of parts) {
    if (part.type === "text") text.push(part.text)
    if (part.type === "audio") throw RequestError.invalidParams(undefined, "Audio prompts are not supported.")
    if (part.type === "resource_link") {
      if (!part.uri) throw RequestError.invalidParams(undefined, "Resource link needs a URI.")

      text.push(part.uri)
    }
    if (part.type === "resource" && "text" in part.resource) {
      const body = part.resource.text
      text.push(part.resource.uri + "\n```\n" + body + (body.endsWith("\n") ? "" : "\n") + "```")
      continue
    }

    const media =
      part.type === "image"
        ? { data: part.data, mime: part.mimeType }
        : part.type === "resource" && "blob" in part.resource
          ? { data: part.resource.blob, mime: part.resource.mimeType ?? "application/octet-stream" }
          : undefined

    if (!media) continue
    if (!media.mime.startsWith("image/") && media.mime !== "application/pdf")
      throw RequestError.invalidParams(undefined, "Unsupported embedded resource media type.")

    const data = media.data.replace(/[ \r\n]/g, "")
    if (data.length > Math.ceil(maxBytes / 3) * 4)
      throw RequestError.invalidParams(undefined, "Editor media exceeds 16 MiB.")

    const bytes = Buffer.from(data, "base64")
    if (!bytes.length || bytes.toString("base64") !== data)
      throw RequestError.invalidParams(undefined, "Editor media data must be valid base64.")
    if (bytes.length > maxBytes) throw RequestError.invalidParams(undefined, "Editor media exceeds 16 MiB.")

    const extension =
      media.mime === "image/svg+xml" ? "svg" : media.mime.split("/")[1].replace(/[^a-z0-9]/gi, "") || "img"

    files.push(new File([bytes], "editor-input-" + (files.length + 1) + "." + extension, { type: media.mime }))
  }

  const prompt = text.join("\n\n")

  if (acceptsPDF && files.some((file) => file.type === "application/pdf") && !acceptsPDF(prompt))
    throw RequestError.invalidParams(undefined, "PDF attachments require a new conversation turn.")

  for (const file of files) {
    signal.throwIfAborted()
    const upload = await client.uploads.create(file, file.name, { signal })

    attachments.push(upload.public_id)
  }

  return { text: prompt, ...(attachments.length ? { attachments } : {}) }
}
