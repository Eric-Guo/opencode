import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EOL } from "os"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { basename } from "path"
import { Cause, Effect } from "effect"
import { Agent } from "../../../agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import type { MessageV2 } from "../../../session/message-v2"
import { MessageID, PartID } from "../../../session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "../../../permission"
import { iife } from "../../../util/iife"
import { fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { MCP } from "../../../mcp"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

export const debugAgent = Effect.fn("Cli.debug.agent")(function* (args: {
  name: string
  tool?: string
  params?: string
}) {
  const ctx = yield* InstanceRef
  if (!ctx) return
  return yield* run(args, ctx)
})

const run = Effect.fn("Cli.debug.agent.body")(function* (
  args: { name: string; tool?: string; params?: string },
  ctx: InstanceContext,
) {
  const agentName = args.name
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  if (!agent) {
    process.stderr.write(
      `Agent ${agentName} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  const cfg = yield* Config.Service.use((svc) => svc.get())
  const mcpConfig = cfg.mcp ?? {}
  const toolConfig = {
    global: cfg.tools ?? {},
    agent: cfg.agent?.[agentName]?.tools ?? {},
  }
  const [availableTools, mcpToolIDs] = yield* Effect.all([getAvailableTools(agent), getAvailableMcpToolIDs(mcpConfig)], {
    concurrency: "unbounded",
  })
  const resolvedTools = resolveTools(agent, [...availableTools.map((tool) => tool.id), ...mcpToolIDs])
  const toolID = args.tool
  if (toolID) {
    const tool = availableTools.find((item) => item.id === toolID)
    if (!tool) {
      process.stderr.write(`Tool ${toolID} not found for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    if (resolvedTools[toolID] === false) {
      process.stderr.write(`Tool ${toolID} is disabled for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    const params = parseToolParams(args.params)
    const toolCtx = yield* createToolContext(agent, ctx)
    const result = yield* tool.execute(params, toolCtx)
    process.stdout.write(JSON.stringify({ tool: toolID, input: params, result }, null, 2) + EOL)
    return
  }

  const output = {
    ...agent,
    tools: resolvedTools,
    mcpConfig,
    toolConfig,
  }
  process.stdout.write(JSON.stringify(output, null, 2) + EOL)
})

const getAvailableTools = Effect.fn("Cli.debug.agent.getAvailableTools")(function* (agent: Agent.Info) {
  const provider = yield* Provider.Service
  const registry = yield* ToolRegistry.Service
  const model =
    agent.model ??
    (yield* provider.defaultModel().pipe(
      Effect.matchCauseEffect({
        onSuccess: Effect.succeed,
        onFailure: (cause) => {
          const error = Cause.squash(cause) as Provider.DefaultModelError
          if (error instanceof Provider.ModelNotFoundError) {
            return fail(`Model not found: ${error.providerID}/${error.modelID}`)
          }
          if (error instanceof Provider.NoModelsError) return fail(`No models found for provider ${error.providerID}`)
          return fail("No providers found")
        },
      }),
    ))
  return yield* registry.tools({ ...model, agent })
})

const getAvailableMcpToolIDs = Effect.fn("Cli.debug.agent.getAvailableMcpToolIDs")(function* (
  mcpConfig: ConfigV1.Info["mcp"] | undefined,
) {
  if (!mcpConfig || Object.keys(mcpConfig).length === 0) return []
  // MCP.tools() only returns tools from connected clients, so configured but disconnected
  // servers may not appear in the resolved tool list.
  const tools = yield* MCP.Service.use((svc) => svc.tools())
  return Object.keys(tools)
})

function resolveTools(agent: Agent.Info, toolIDs: string[]) {
  const disabled = Permission.disabled(toolIDs, agent.permission)
  const resolved: Record<string, boolean> = {}
  for (const toolID of toolIDs) {
    resolved[toolID] = !disabled.has(toolID)
  }
  return resolved
}

function parseToolParams(input?: string) {
  if (!input) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}

  const parsed = iife(() => {
    try {
      return JSON.parse(trimmed)
    } catch (jsonError) {
      try {
        return new Function(`return (${trimmed})`)()
      } catch (evalError) {
        throw new Error(
          `Failed to parse --params. Use JSON or a JS object literal. JSON error: ${jsonError}. Eval error: ${evalError}.`,
          { cause: evalError },
        )
      }
    }
  })

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool params must be an object.")
  }
  return parsed as Record<string, unknown>
}

const createToolContext = Effect.fn("Cli.debug.agent.createToolContext")(function* (
  agent: Agent.Info,
  ctx: InstanceContext,
) {
  const sessionSvc = yield* Session.Service
  const session = yield* sessionSvc.create({ title: `Debug tool run (${agent.name})` })
  const messageID = MessageID.ascending()
  const model = agent.model
    ? agent.model
    : yield* Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.defaultModel().pipe(
          Effect.matchCauseEffect({
            onSuccess: Effect.succeed,
            onFailure: (cause) => {
              const error = Cause.squash(cause) as Provider.DefaultModelError
              if (error instanceof Provider.ModelNotFoundError) {
                return fail(`Model not found: ${error.providerID}/${error.modelID}`)
              }
              if (error instanceof Provider.NoModelsError)
                return fail(`No models found for provider ${error.providerID}`)
              return fail("No providers found")
            },
          }),
        )
      })
  const now = Date.now()
  const message: SessionV1.Assistant = {
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    time: { created: now },
    parentID: messageID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "debug",
    agent: agent.name,
    path: {
      cwd: ctx.directory,
      root: ctx.worktree,
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* sessionSvc.updateMessage(message)

  const ruleset = Permission.merge(agent.permission, session.permission ?? [])

  return {
    sessionID: session.id,
    messageID,
    callID: PartID.ascending(),
    agent: agent.name,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask(req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) {
      return Effect.sync(() => {
        for (const pattern of req.patterns) {
          const rule = Permission.evaluate(req.permission, pattern, ruleset)
          if (rule.action === "deny") {
            throw new PermissionV1.DeniedError({ ruleset })
          }
        }
      })
    },
  }
})
