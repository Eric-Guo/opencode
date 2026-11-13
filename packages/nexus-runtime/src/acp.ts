import { client, ndJsonStream } from "@agentclientprotocol/sdk"
import { spawn } from "node:child_process"
import { Writable, Readable } from "node:stream"
import { Schema } from "effect"
import { definition, type RunnerTool } from "./extensions"

const Config = Schema.Record(Schema.String, Schema.NonEmptyArray(Schema.NonEmptyString))

export function acpTool(config: string): RunnerTool {
  const commands = Schema.decodeUnknownSync(Schema.fromJsonString(Config))(config)
  return {
    definition: {
      timeout_ms: 300000,
      ...definition(
        "delegate_agent",
        "Send an assignment to a configured ACP agent. The child runs in the selected project.",
        { agent: { enum: Object.keys(commands) }, prompt: { type: "string" } },
        ["agent", "prompt"],
      ),
    },
    async execute(input, ctx) {
      if (typeof input.agent !== "string" || !Object.hasOwn(commands, input.agent) || typeof input.prompt !== "string")
        throw new Error("Choose a configured agent and a prompt.")
      const [command, ...args] = commands[input.agent]
      const child = spawn(command, args, {
        cwd: ctx.directory,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          SystemRoot: process.env.SystemRoot,
        },
      })
      const exit = new Promise<never>((_, reject) => {
        child.once("error", reject)
        child.once("close", () => reject(new Error("The delegated agent disconnected.")))
      })
      let output = ""
      const connection = client({ name: "OpenCode Nexus" })
        .onNotification("session/update", ({ params }) => {
          const update = params.update
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
            output = (output + update.content.text).slice(-65536)
        })
        .onRequest("session/request_permission", async ({ params }) => {
          const once = params.options.find((option) => option.kind === "allow_once")
          if (!once || !ctx.ask) return { outcome: { outcome: "cancelled" } }
          const answer = await ctx.ask(
            "acp_" + crypto.randomUUID(),
            JSON.stringify({
              agent: input.agent,
              action: params.toolCall.title,
              input: params.toolCall.rawInput,
            }).slice(0, 8192),
            ["Allow once", "Deny"],
          )
          return answer === "Allow once"
            ? { outcome: { outcome: "selected", optionId: once.optionId } }
            : { outcome: { outcome: "cancelled" } }
        })
        .connect(
          ndJsonStream(
            Writable.toWeb(child.stdin),
            Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
          ),
        )
      const options = { cancellationSignal: ctx.signal }
      try {
        return await Promise.race([
          exit,
          (async () => {
            await connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, options)
            const { sessionId } = await connection.agent.request(
              "session/new",
              { cwd: ctx.directory, mcpServers: [] },
              options,
            )
            const result = await connection.agent.request(
              "session/prompt",
              { sessionId, prompt: [{ type: "text", text: input.prompt as string }] },
              options,
            )
            return { content: output || result.stopReason }
          })(),
        ])
      } finally {
        child.stdin.end()
        child.kill()
        const timer = setTimeout(() => child.kill("SIGKILL"), 1500)
        timer.unref()
        child.once("close", () => clearTimeout(timer))
      }
    },
  }
}
