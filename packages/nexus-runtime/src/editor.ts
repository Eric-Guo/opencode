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
import { Client, type ExecutionDecision, type InputExecution, type JsonObject, type Model } from "@cybros/agent"
import { setTimeout } from "node:timers/promises"
import { Schema } from "effect"
import type { Status } from "./runtime"
import { authenticateEditor, type EditorAuthentication } from "./editor-auth"
import { editorBridge, editorRoots } from "./editor-bridge"
import { EditorTranscript } from "./editor-follow"
import { replayEditorHistory } from "./editor-replay"

type Mode = "bypass" | "ask" | "rules"
type Session = {
  roots: string[]
  mode: Mode
  model?: string
  code: boolean
  bridge: ReturnType<Awaited<ReturnType<typeof editorBridge>>["attach"]>
  grants: Set<string>
  mcp: readonly string[]
  last?: { execution: InputExecution; transcript: EditorTranscript }
  question?: { decision: ExecutionDecision; execution: InputExecution; transcript: EditorTranscript }
}
export type EditorOptions = {
  open?: () => Promise<string>
  accepted?: (conversation: string, input: string, text: string, model: string, replayed: boolean) => Promise<void>

  authentication?: EditorAuthentication
  setEnvironment?: (conversation: string, binding: Session["bridge"] | null) => Promise<void>
  codeMode?: (conversation: string) => Promise<boolean>
  setCodeMode?: (conversation: string, enabled: boolean) => Promise<void>
  attachMcp?: (input: {
    conversation: string
    cwd: string
    servers: readonly McpServer[]
  }) => Promise<{ tools: readonly string[]; issues: readonly string[] }>
  detachMcp?: (conversation: string) => Promise<void>
}

export async function editor(
  stream: Stream,
  status: Status,
  token: string,
  policy: (
    conversation: string,
    model?: string,
  ) => Promise<{
    tools: readonly string[]
    instructions?: string
    agent_configuration?: JsonObject
    model?: string
    fallback_models?: readonly string[]
    executor_contexts?: Record<string, JsonObject>
  }>,
  options: EditorOptions = {},
) {
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
    state.models = await nexus.client.models.list({ workload: "chat" }, { signal })
    state.authenticated = true
  }

  const requireSession = (id: string) => {
    const session = sessions.get(id)

    if (!session) throw RequestError.resourceNotFound(id)

    return session
  }
  const projection = (id: string, peer: AgentContext) =>
    new EditorTranscript(id, peer, (run, task) =>
      nexus.workspace
        .run(run)
        .task(task)
        .fetch({ signal: pending.get(id)?.signal }),
    )
  const catchUp = async (
    execution: InputExecution,
    moved: (snapshot: NonNullable<InputExecution["snapshot"]>) => boolean,
    signal: AbortSignal,
  ) => {
    const deadline = performance.now() + 5000

    while (!signal.aborted) {
      const snapshot = await execution.recover({ signal })

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
    const watchers: Promise<void>[] = []
    const runs = new Set<string>()

    try {
      while (!signal.aborted) {
        const snapshot = await execution.recover({ signal })

        if (execution.blocked_reason) throw new RequestError(-32603, execution.blocked_reason)
        if (snapshot) transcript.execution(snapshot.execution)
        if (snapshot?.execution.run_public_id) {
          const run = snapshot.execution.run_public_id

          if (!runs.has(run)) {
            runs.add(run)
            watchers.push(
              (async () => {
                const { RealtimeClient } = await import("@cybros/agent/realtime")
                const realtime = new RealtimeClient({
                  baseURL: nexus.status.origin,
                  credentialProvider,
                  timeoutMs: 5000,
                })

                try {
                  const options = { signal: AbortSignal.any([signal, streaming.signal]) }

                  await Promise.allSettled([
                    (async () => {
                      for await (const frame of await realtime.runTranscript(nexus.identity!.workspace, run, options))
                        await transcript.frame(frame)
                    })(),
                    (async () => {
                      for await (const frame of await realtime.runProgress(nexus.identity!.workspace, run, options))
                        await transcript.progress(frame)
                    })(),
                  ])
                } finally {
                  await realtime.close()
                }
              })().catch(() => {}),
            )
          }
          const rows = await nexus.workspace.run(run).transcript({ limit: 100 }, { signal })

          for (const round of rows.rounds.filter((round) => round.mainline))
            for (const call of round.calls.items) await transcript.call(run, call)
        }
        if (snapshot?.terminal) {
          streaming.abort()
          await Promise.allSettled(watchers)
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
              await transcript.question(decision.detail.prompt ?? "Answer requested.")
              return { stopReason: "end_turn" as const }
            }

            const task = decision.detail.task
            const grant = JSON.stringify([task.tool_name, decision.detail.tool_input])

            if (session.grants.has(grant)) {
              await decision.task.approve({ signal })
              continue
            }

            const response = await peer.request(
              "session/request_permission",
              {
                sessionId: id,
                toolCall: {
                  toolCallId: snapshot.execution.run_public_id + ":" + task.key,
                  title: task.tool_name ?? task.key,
                  rawInput: decision.detail.tool_input,
                },
                options: [
                  { optionId: "approve", name: "Allow once", kind: "allow_once" },
                  { optionId: "always", name: "Allow for this session", kind: "allow_always" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              },
              { cancellationSignal: signal },
            )

            if (signal.aborted) break
            if (response.outcome.outcome === "selected" && ["approve", "always"].includes(response.outcome.optionId)) {
              if (response.outcome.optionId === "always") session.grants.add(grant)
              await decision.task.approve({ signal })
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
      await Promise.allSettled(watchers)
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
        if (!state.capabilities.elicitation?.form) {
          await question.transcript.question(question.decision.detail.prompt ?? "Answer requested.")
          return
        }

        await follow(id, session, question.execution, question.transcript, peer, owner.signal)
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
    ...(options.setCodeMode
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
    roots: string[],
    servers: readonly McpServer[],
    peer: AgentContext,
    signal: AbortSignal,
    replay: boolean,
  ) => {
    if (pending.has(id)) throw RequestError.invalidRequest(undefined, "The editor session is busy.")

    const conversation = await nexus.workspace.conversation(id).fetch({ signal })

    if (conversation.answering_user_public_id !== nexus.identity?.agent || conversation.archived_at)
      throw RequestError.resourceNotFound(id)
    if (
      typeof conversation.metadata["opencode.acp.cwd"] === "string" &&
      conversation.metadata["opencode.acp.cwd"] !== roots[0]
    )
      throw RequestError.invalidParams(undefined, "The session working directory cannot be changed.")

    const saved = conversation.metadata["opencode.acp.mode"]
    const mcp = await options.attachMcp?.({ conversation: id, cwd: roots[0], servers })
    const session: Session = {
      roots,
      mode: saved === "bypass" || saved === "rules" ? saved : "ask",
      model:
        typeof conversation.metadata["opencode.acp.model"] === "string"
          ? conversation.metadata["opencode.acp.model"]
          : undefined,
      code: options.codeMode ? await options.codeMode(id) : conversation.metadata["opencode.acp.code"] !== false,
      bridge: bridge.attach(id, roots, peer, state.capabilities),
      grants: new Set(),
      mcp: mcp?.tools ?? [],
    }

    await options.setEnvironment?.(id, session.bridge)
    sessions.set(id, session)
    if (replay) await replayEditorHistory(nexus.workspace, id, peer, signal)
    if (conversation.active_turn_public_id) {
      const deck = await nexus.workspace.conversation(id).turns.variants(conversation.active_turn_public_id, { signal })
      const variant = deck.items.find((variant) => variant.active)

      if (variant?.run_public_id) {
        session.last = {
          execution: nexus.workspace.conversation(id).execution({
            turn_public_id: conversation.active_turn_public_id,
            variant_public_id: variant.public_id,
            run_public_id: variant.run_public_id,
          }),
          transcript: projection(id, peer),
        }
        const decision = (await nexus.workspace.run(variant.run_public_id).decisions({ signal })).find(
          (decision) => decision.kind === "ask",
        )

        if (decision)
          session.question = {
            decision,
            ...session.last,
          }
      }
    }

    await peer.notify("session/update", {
      sessionId: id,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "retry", description: "Retry the holding task." },
          { name: "abandon", description: "Abandon the holding task." },
          { name: "compact", description: "Compact this conversation." },
        ],
      },
    })

    restoreQuestion(id, session, peer)
    return {
      modes: { currentModeId: session.mode, availableModes: modes },
      configOptions: config(session),
      ...(mcp?.issues.length ? { _meta: { "opencode.mcp.issues": mcp.issues } } : {}),
    }
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
      const roots = await editorRoots(params.cwd, params.additionalDirectories)

      validateServers(params.mcpServers, !!options.attachMcp)

      const result = options.open
        ? { conversation: { public_id: await options.open() } }
        : await nexus.workspace.conversations.create(
            {
              answering_user_public_id: nexus.identity!.agent,
              default_runner_executor_public_id: nexus.identity!.runner,
              metadata: { "opencode.surface": "acp", "opencode.acp.cwd": roots[0] },
            },
            { signal, idempotencyKey: crypto.randomUUID() },
          )
      const id = result.conversation.public_id

      return { sessionId: id, ...(await attach(id, roots, params.mcpServers, peer, signal, false)) }
    })
    .onRequest("session/load", async ({ params, signal, client: peer }) => {
      await authenticate(signal)
      validateServers(params.mcpServers, !!options.attachMcp)

      return attach(
        params.sessionId,
        await editorRoots(params.cwd, params.additionalDirectories),
        params.mcpServers,
        peer,
        signal,
        true,
      )
    })
    .onRequest("session/resume", async ({ params, signal, client: peer }) => {
      await authenticate(signal)
      validateServers(params.mcpServers ?? [], !!options.attachMcp)

      return attach(
        params.sessionId,
        await editorRoots(params.cwd, params.additionalDirectories),
        params.mcpServers ?? [],
        peer,
        signal,
        false,
      )
    })
    .onRequest("session/close", async ({ params }) => {
      requireSession(params.sessionId)
      pending.get(params.sessionId)?.abort()
      sessions.delete(params.sessionId)
      bridge.release(params.sessionId)
      await options.detachMcp?.(params.sessionId)
      await options.setEnvironment?.(params.sessionId, null)
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
        const models = await nexus.client.models.list({ workload: "chat" }, { signal })

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
      await nexus.workspace.conversation(params.sessionId).cancel()
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
        const prompt = await editorPrompt(ctx.params.prompt, nexus.client, signal)
        const command = /^\/(retry|abandon|compact)(?:\s|$)/.exec(prompt.text)?.[1]

        if (command === "compact") {
          await chat.compact(undefined, { signal })
          return { stopReason: "end_turn" as const }
        }
        if (command === "retry" || command === "abandon") {
          const snapshot = await session.last?.execution.recover({ signal })
          const runID = snapshot?.execution.run_public_id

          if (!runID) throw new RequestError(-32603, "There is no holding task in this editor session.")

          const run = await nexus.workspace.run(runID).fetch({ signal })
          const candidates = run.tasks.filter((task) => ["failed", "timed_out", "uncertain"].includes(task.status))

          if (candidates.length !== 1)
            throw new RequestError(-32603, "A single holding task is required; select the task in OpenCode.")

          if (command === "abandon") {
            await nexus.workspace.run(runID).task(candidates[0].key).abandon({ signal })
            return { stopReason: "end_turn" as const }
          }

          await nexus.workspace.run(runID).task(candidates[0].key).retry(undefined, { signal })
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
                  const choices = await policy(id, session.model)
                  const receipt = await chat.inputs.create(
                    {
                      kind: "direct_reply",
                      ...prompt,
                      instructions: choices.instructions,
                      model: { model: session.model ?? choices.model ?? nexus.status.model },
                      agent_configuration: choices.agent_configuration,
                      ...(choices.fallback_models ? { fallback_models: [...choices.fallback_models] } : {}),
                      approval_mode: session.mode,
                      tool_names: [...new Set([...choices.tools, ...session.mcp])],
                      executor_contexts: {
                        ...choices.executor_contexts,
                        [nexus.identity!.runner]: {
                          ...choices.executor_contexts?.[nexus.identity!.runner],
                          "opencode.directory": session.roots[0],
                          "opencode.roots": session.roots,
                          ...(!options.setEnvironment ? { "opencode.editor": session.bridge } : {}),
                        },
                      },
                    },
                    { signal, idempotencyKey: crypto.randomUUID() },
                  )

                  void options
                    .accepted?.(
                      id,
                      receipt.input.public_id,
                      prompt.text ?? "",
                      session.model ?? choices.model ?? nexus.status.model,
                      receipt.replayed,
                    )
                    .catch(() => {})
                  return chat.inputExecution(receipt.input.public_id)
                })()

        session.last = { execution, transcript }

        if (question) {
          await question.decision.task.resolve({ content: prompt.text }, { signal })
          session.question = undefined
          await answered(execution, question.decision, signal)
        }
        return await follow(id, session, execution, transcript, ctx.client, signal)
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
      [...sessions.keys()].flatMap((id) => [options.detachMcp?.(id), options.setEnvironment?.(id, null)]),
    )
  }
}

function validateServers(servers: readonly McpServer[], supported: boolean) {
  if (servers.length && !supported)
    throw RequestError.invalidParams(undefined, "Session MCP attachments are unavailable.")
  if (new Set(servers.map((server) => server.name)).size !== servers.length)
    throw RequestError.invalidParams(undefined, "Duplicate MCP server names.")
}

const modes = [
  { id: "bypass", name: "Bypass", description: "Run tools without approval prompts." },
  { id: "ask", name: "Ask", description: "Ask before operations requiring approval." },
  { id: "rules", name: "Rules", description: "Apply the configured approval rules." },
]

export async function editorPrompt(parts: readonly ContentBlock[], client: Client, signal: AbortSignal) {
  const text: string[] = []
  const attachments: string[] = []

  for (const part of parts) {
    if (part.type === "text") text.push(part.text)
    if (part.type === "audio") throw RequestError.invalidParams(undefined, "Audio prompts are not supported.")
    if (part.type === "resource_link")
      text.push("resource: " + part.uri + (part.description ? "\n" + part.description : ""))
    if (part.type === "resource" && "text" in part.resource) text.push(part.resource.uri + "\n" + part.resource.text)

    const media =
      part.type === "image"
        ? { data: part.data, mime: part.mimeType }
        : part.type === "resource" && "blob" in part.resource
          ? { data: part.resource.blob, mime: part.resource.mimeType ?? "application/octet-stream" }
          : undefined

    if (!media) continue
    if (!media.mime.startsWith("image/") && media.mime !== "application/pdf")
      throw RequestError.invalidParams(undefined, "Unsupported embedded resource media type.")
    if (media.data.length > Math.ceil((16 * 1024 * 1024) / 3) * 4)
      throw RequestError.invalidParams(undefined, "Editor media exceeds 16 MiB.")

    const upload = await client.uploads.create(
      new Blob([Buffer.from(media.data, "base64")], { type: media.mime }),
      "editor-input-" + (attachments.length + 1),
      { signal },
    )

    attachments.push(upload.public_id)
  }

  return { text: text.join("\n\n"), ...(attachments.length ? { attachments } : {}) }
}
