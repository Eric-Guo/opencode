import { EOL } from "node:os"
import { Effect } from "effect"
import { OpenCode } from "@opencode-ai/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "@opencode-ai/client/effect/service"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands.debug.commands.agent,
  Effect.fn("cli.debug.agent")(function* (input) {
    const options = yield* ServiceConfig.options()
    const found = yield* Service.discover(options)
    const endpoint = found ?? (yield* Service.ensure(options))
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const location = { directory: process.cwd() }
    const [agents, mcp] = yield* Effect.promise(() =>
      Promise.all([client.agent.list({ location }), client.mcp.list({ location })]),
    )
    const agent = agents.data.find((item) => item.id === input.name)
    if (!agent) return yield* Effect.fail(new Error(`Agent ${input.name} not found`))
    process.stdout.write(
      JSON.stringify(
        {
          ...agent,
          tools: { permissions: agent.permissions },
          mcp: mcp.data,
        },
        null,
        2,
      ) + EOL,
    )
  }),
)
