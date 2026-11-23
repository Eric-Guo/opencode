import { Schema } from "effect"
import type { ExtensionAPI } from "../src/extension-manager"
import { RunsOperation } from "../src/operations"
import { DevelopmentStreams } from "./streams"

/** Source-only development surface, loaded explicitly through OPENCODE_NEXUS_EXTENSIONS. */
export function register(api: ExtensionAPI) {
  const streams = new DevelopmentStreams(() => api.application(), api.signal)
  api.onShutdown(() => streams.close())
  api.on("host.ended", async (value) => {
    const event = Schema.decodeUnknownSync(Schema.Struct({ conversation: Schema.String }))(value)
    await streams.release(event.conversation)
  })
  api.registerCommand("dev", async (input) => {
    const action = Schema.decodeUnknownSync(Schema.Struct({ action: Schema.String }))(input).action
    if (action.startsWith("stream.")) return streams.command(input)
    if (action === "followers") {
      const conversations = await api.application().operations.command(input, { signal: api.signal })
      const runs = Schema.decodeUnknownSync(Schema.Struct({ side: Schema.optional(Schema.Boolean) }))(input).side
        ? []
        : await streams.command({ action: "stream.followers" })
      return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify({ conversations, runs }))
    }
    const operations = api.application().operations
    const result =
      action === "runs"
        ? await operations.runs(Schema.decodeUnknownSync(RunsOperation)(input), streams.followedRuns(), {
            signal: api.signal,
          })
        : await operations.command(input, { signal: api.signal })

    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(result ?? null))
  })
}
