import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Permission } from "@opencode-ai/core/permission"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Session } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Tool } from "@opencode-ai/core/tool"
import {
  AgentNotFoundError,
  ForbiddenError,
  InvalidRequestError,
  ServiceUnavailableError,
} from "@opencode-ai/protocol/errors"
import { Effect, Option, RcMap, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requestRef, response } from "../location"

export const DebugHandler = HttpApiBuilder.group(Api, "server.debug", (handlers) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service
    return handlers
      .handle(
        "debug.location",
        Effect.fn(function* () {
          const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
          return Array.from(yield* RcMap.keys(locations.rcMap))
        }),
      )
      .handle(
        "debug.location.evict",
        Effect.fn(function* (ctx) {
          const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
          // Resolve through requestRef so the key matches the shape the location
          // middleware cached the services under.
          yield* locations.invalidate(requestRef(ctx.request))
        }),
      )
      .handle(
        "debug.agent.tools",
        Effect.fn("server.debug.agent.tools")(function* (ctx) {
          const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
          return yield* listAgentTools(ctx.params.agentID).pipe(Effect.provide(locations.get(requestRef(ctx.request))))
        }),
      )
      .handle(
        "debug.agent.executeTool",
        Effect.fn("server.debug.agent.executeTool")(function* (ctx) {
          const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
          return yield* executeAgentTool(ctx.params.agentID, ctx.params.toolID, ctx.payload, bus, sessions).pipe(
            Effect.provide(locations.get(requestRef(ctx.request))),
          )
        }),
      )
  }),
)

const listAgentTools = Effect.fn("server.debug.agent.listTools")(function* (agentID: Agent.ID) {
  const agent = yield* requireAgent(agentID)
  yield* awaitPlugins()
  const registry = yield* Tool.Service
  const available = toolIDs(yield* registry.snapshot())
  const enabled = new Set(toolIDs(yield* registry.snapshot(agent.permissions)))
  return yield* response(Effect.succeed(Object.fromEntries(available.map((id) => [id, enabled.has(id)]))))
})

const executeAgentTool = Effect.fn("server.debug.agent.execute")(function* (
  agentID: Agent.ID,
  toolID: string,
  params: Readonly<Record<string, unknown>>,
  bus: Bus.Interface,
  sessions: Session.Interface,
) {
  const agent = yield* requireAgent(agentID)
  yield* awaitPlugins()
  const registry = yield* Tool.Service
  const available = toolIDs(yield* registry.snapshot())
  if (!available.includes(toolID))
    return yield* new InvalidRequestError({
      message: `Tool ${toolID} not found for agent ${agent.id}`,
      field: "toolID",
    })
  const tools = yield* registry.snapshot(agent.permissions)
  if (!toolIDs(tools).includes(toolID))
    return yield* new ForbiddenError({ message: `Tool ${toolID} is disabled for agent ${agent.id}` })

  const location = yield* Location.Service
  const session = yield* sessions
    .create({
      title: `Debug tool run (${agent.name})`,
      agent: agent.id,
      location: { directory: location.directory, workspaceID: location.workspaceID },
    })
    .pipe(Effect.orDie)
  const permissions = yield* Permission.Service
  yield* bus.subscribe(Permission.Event.Asked).pipe(
    Stream.filter((event) => event.data.sessionID === session.id),
    Stream.runForEach((event) => permissions.reply({ requestID: event.data.id, reply: "once" }).pipe(Effect.orDie)),
    Effect.forkScoped({ startImmediately: true }),
  )
  const result = yield* tools
    .execute({
      sessionID: session.id,
      agent: agent.id,
      messageID: SessionMessage.ID.create(),
      call: {
        type: "tool-call",
        id: `debug-${Date.now()}`,
        name: toolID,
        input: params,
      },
      allowUnadvertised: true,
    })
    .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))
  return yield* response(Effect.succeed(result))
})

const awaitPlugins = Effect.fn("server.debug.agent.awaitPlugins")(function* () {
  const plugins = yield* PluginSupervisor.Service
  yield* plugins.flush.pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(
          new ServiceUnavailableError({ message: "Tool initialization timed out", service: "tool-registry" }),
        ),
    }),
  )
})

const requireAgent = Effect.fn("server.debug.agent.require")(function* (agentID: Agent.ID) {
  const service = yield* Agent.Service
  const agent = yield* service.get(agentID)
  if (agent) return agent
  return yield* new AgentNotFoundError({ agentID, message: `Agent not found: ${agentID}` })
})

const toolIDs = (snapshot: Tool.Snapshot) =>
  [
    ...snapshot.definitions.map((tool) => tool.name),
    ...(snapshot.codeModeCatalog ?? []).map((tool) => tool.path.replaceAll(".", "_")),
  ]
    .filter((name) => !["execute", "tool_search"].includes(name))
    .toSorted()
