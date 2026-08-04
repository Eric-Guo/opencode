import { EOL } from "node:os"
import { Effect, Option, Schema } from "effect"
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
    const agents = yield* Effect.promise(() => client.agent.list({ location }))
    const agent =
      agents.data.find((item) => item.id === input.name) ?? agents.data.find((item) => item.name === input.name)
    if (!agent) return yield* Effect.fail(new Error(`Agent ${input.name} not found`))
    const tools = yield* Effect.promise(() => client.debug.agent.tools({ agentID: agent.id, location }))
    const toolID = Option.getOrUndefined(input.tool)
    if (toolID) {
      if (!(toolID in tools.data))
        return yield* Effect.fail(new Error(`Tool ${toolID} not found for agent ${input.name}`))
      if (!tools.data[toolID])
        return yield* Effect.fail(new Error(`Tool ${toolID} is disabled for agent ${input.name}`))
      const params = parseToolParams(Option.getOrUndefined(input.params))
      const response = yield* Effect.promise(() =>
        client.debug.agent.executeTool({ agentID: agent.id, toolID, location, payload: params }),
      )
      process.stdout.write(JSON.stringify({ tool: toolID, input: params, result: response.data }, null, 2) + EOL)
      return yield* Effect.void
    }
    process.stdout.write(
      JSON.stringify(
        {
          ...agent,
          tools: tools.data,
        },
        null,
        2,
      ) + EOL,
    )
    return yield* Effect.void
  }),
)

const ToolParams = Schema.Record(Schema.String, Schema.Json)
const isToolParams = Schema.is(ToolParams)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function parseToolParams(input?: string) {
  if (!input?.trim()) return {}
  const trimmed = input.trim()
  const json = decodeJson(trimmed)
  const parsed = Option.isSome(json)
    ? json.value
    : (() => {
        try {
          // This local debug flag intentionally accepts the caller's JavaScript object literal.
          // eslint-disable-next-line typescript-eslint/no-implied-eval
          return new Function(`return (${trimmed})`)()
        } catch (evalError) {
          throw new Error(
            `Failed to parse --params. Use JSON or a JavaScript object literal. JSON parsing failed. Eval error: ${String(evalError)}.`,
            { cause: evalError },
          )
        }
      })()
  if (!isToolParams(parsed)) throw new Error("Tool params must be a JSON object.")
  return parsed
}
