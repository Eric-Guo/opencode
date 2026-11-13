import { agent, type Stream } from "@agentclientprotocol/sdk"
import { Client, type ExecutionDecision, type InputExecution } from "@cybros/agent"
import { realpath } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import type { Status } from "./runtime"

export async function editor(
  stream: Stream,
  status: Status,
  token: string,
  policy: (conversation: string) => Promise<{ tools: readonly string[] }>,
) {
  if (status.state !== "ready" || !status.identity)
    throw new Error("Pair OpenCode before starting the Nexus ACP agent.")
  const identity = status.identity
  const client = new Client({ baseURL: status.origin, credential: token })
  if ((await client.profile.fetch()).member.kind !== "human") throw new Error("A Human member token is required.")
  const workspace = client.workspace(identity.workspace)
  await workspace.fetch()
  const sessions = new Set<string>()
  const pending = new Map<string, AbortController>()
  const questions = new Map<string, { decision: ExecutionDecision; execution: InputExecution }>()
  const app = agent({ name: "OpenCode Nexus" })
    .onRequest("initialize", () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
      agentInfo: { name: "OpenCode Nexus", version: "1" },
    }))
    .onRequest("session/new", async ({ params, signal }) => {
      if ((await realpath(params.cwd)) !== status.directory)
        throw new Error("Open the paired runner directory in your editor.")
      if (params.mcpServers.length) throw new Error("Select MCP servers in the OpenCode service configuration.")
      const result = await workspace.conversations.create(
        {
          answering_user_public_id: identity.agent,
          default_runner_executor_public_id: identity.runner,
          metadata: { "opencode.surface": "acp" },
        },
        { signal, idempotencyKey: crypto.randomUUID() },
      )
      sessions.add(result.conversation.public_id)
      return { sessionId: result.conversation.public_id }
    })
    .onNotification("session/cancel", async ({ params }) => {
      if (!sessions.has(params.sessionId)) return
      questions.delete(params.sessionId)
      pending.get(params.sessionId)?.abort()
      await workspace.conversation(params.sessionId).cancel()
    })
    .onRequest("session/prompt", async (ctx) => {
      const id = ctx.params.sessionId
      if (!sessions.has(id) || pending.has(id)) throw new Error("Unknown or busy editor session.")
      const text = ctx.params.prompt
        .map((part) => {
          if (part.type !== "text") throw new Error("Nexus accepts text prompts.")
          return part.text
        })
        .join("\n")
      const owner = new AbortController()
      pending.set(id, owner)
      const signal = AbortSignal.any([owner.signal, ctx.signal])
      const chat = workspace.conversation(id)
      try {
        const question = questions.get(id)
        const execution = question
          ? question.execution
          : await (async () => {
              const choices = await policy(id)
              const receipt = await chat.inputs.create(
                {
                  kind: "direct_reply",
                  text,
                  model: { model: status.model },
                  approval_mode: "ask",
                  tool_names: [...choices.tools],
                  executor_contexts: { [identity.runner]: { "opencode.directory": status.directory } },
                },
                { signal, idempotencyKey: crypto.randomUUID() },
              )
              return chat.inputExecution(receipt.input.public_id)
            })()
        if (question) {
          await question.decision.task.resolve({ content: text }, { signal })
          questions.delete(id)
        }
        while (!signal.aborted) {
          const snapshot = await execution.recover({ signal })
          if (execution.blocked_reason) throw new Error(execution.blocked_reason)
          if (snapshot?.terminal) {
            await ctx.client.notify("session/update", {
              sessionId: id,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: snapshot.content ?? snapshot.failure_reason ?? snapshot.status ?? "" },
              },
            })
            return { stopReason: "end_turn" }
          }
          if (snapshot?.execution.run_public_id) {
            for (const decision of await execution.decisions({ signal })) {
              if (decision.kind === "ask") {
                questions.set(id, { decision, execution })
                await ctx.client.notify("session/update", {
                  sessionId: id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: decision.detail.prompt ?? "Answer requested." },
                  },
                })
                return { stopReason: "end_turn" }
              }
              const task = decision.detail.task
              const result = await ctx.client.request(
                "session/request_permission",
                {
                  sessionId: id,
                  toolCall: {
                    toolCallId: task.key,
                    title: task.tool_name ?? task.key,
                    rawInput: decision.detail.tool_input,
                  },
                  options: [
                    { optionId: "approve", name: "Allow once", kind: "allow_once" },
                    { optionId: "deny", name: "Deny", kind: "reject_once" },
                  ],
                },
                { cancellationSignal: signal },
              )
              if (result.outcome.outcome === "selected" && result.outcome.optionId === "approve")
                await decision.task.approve({ signal })
              else await decision.task.deny(undefined, { signal })
            }
          }
          await delay(500, undefined, { signal })
        }
        return { stopReason: "cancelled" }
      } catch (error) {
        if (signal.aborted) return { stopReason: "cancelled" }
        throw error
      } finally {
        pending.delete(id)
      }
    })
  const connection = app.connect(stream)
  await connection.closed
}
