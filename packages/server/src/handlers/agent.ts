import { Agent } from "@opencode-ai/core/agent"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { AgentNotFoundError, ServiceUnavailableError } from "@opencode-ai/protocol/errors"

export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers
    .handle("agent.list", () =>
      Effect.gen(function* () {
        yield* awaitPlugins()
        return yield* response(Agent.Service.use((agent) => agent.list()))
      }),
    )
    .handle(
      "agent.get",
      Effect.fn(function* (ctx) {
        yield* awaitPlugins()
        const agent = yield* Agent.Service.use((service) => service.get(ctx.params.agentID))
        if (!agent)
          return yield* new AgentNotFoundError({
            agentID: ctx.params.agentID,
            message: `Agent not found: ${ctx.params.agentID}`,
          })
        return yield* response(Effect.succeed(agent))
      }),
    ),
)

// Agent state is populated by plugin activation, which runs asynchronously
// after the location layer boots; wait for it or fail like the other handlers.
const awaitPlugins = Effect.fn("server.agent.awaitPlugins")(function* () {
  const plugins = yield* PluginSupervisor.Service
  yield* plugins.flush.pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(new ServiceUnavailableError({ message: "Agent initialization timed out", service: "agent" })),
    }),
  )
})
