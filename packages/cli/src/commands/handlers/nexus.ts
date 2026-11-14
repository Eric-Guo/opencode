import { OpenCode } from "@opencode/client/promise"
import { Service } from "@opencode/client/effect/service"
import { Effect, Option, Schema } from "effect"
import { resolve } from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"

export default Runtime.handler(
  Commands.commands.nexus,
  Effect.fn("cli.nexus")(function* (input) {
    const server = yield* ServerConnection.resolve({ mismatch: "ignore" })
    const nexus = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
      .experimental.nexus
    if (input.action === "acp") {
      return yield* Effect.tryPromise(async () => {
        const { ndJsonStream } = await import("@agentclientprotocol/sdk")
        const { Readable, Writable } = await import("node:stream")
        const { editor, authenticateEditorTerminal } = await import("@opencode/nexus-runtime/editor")
        const current = { status: await nexus.status() }
        const workspace = () => current.status.identity?.workspace ?? current.status.workspace
        const authentication = {
          status: async () => (current.status = await nexus.status()),
          credential: async () => {
            if (process.env.NEXUS_URL === current.status.origin && process.env.NEXUS_MEMBER_TOKEN)
              return process.env.NEXUS_MEMBER_TOKEN

            return Schema.decodeUnknownSync(Schema.NullOr(Schema.String))(
              await nexus.manage({ payload: { action: "extension.call", name: "editor.auth.credential", input: {} } }),
            )
          },
          start: async () => {
            if (!current.status.origin) {
              const origin = Option.getOrUndefined(input.url) ?? process.env.NEXUS_URL
              const model = Option.getOrUndefined(input.model) ?? process.env.NEXUS_MODEL

              if (!origin || !model) throw new Error("Configure Nexus with --url and --model before authenticating.")

              current.status = await nexus.pair({
                origin,
                model,
                workspace: Option.getOrElse(input.workspace, () => ""),
                directory: resolve(Option.getOrElse(input.directory, () => process.cwd())),
              })
            }

            return Schema.decodeUnknownSync(
              Schema.Struct({ url: Schema.String, code: Schema.optional(Schema.String) }),
            )(await nexus.manage({ payload: { action: "extension.call", name: "editor.auth.start", input: {} } }))
          },
        }

        if (process.env.OPENCODE_NEXUS_ACP_AUTH === "1") {
          await authenticateEditorTerminal(
            authentication,
            (message) => {
              process.stdout.write(message + "\n")
            },
            AbortSignal.timeout(10 * 60000),
          )
          return
        }

        await editor(
          ndJsonStream(
            Writable.toWeb(process.stdout),
            Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
          ),
          current.status,
          "",
          (conversation) => nexus.policy({ workspace: workspace(), conversation }),
          {
            authentication,
            setEnvironment: async (conversation, binding) => {
              await nexus.manage({
                payload: {
                  action: "extension.call",
                  name: "editor.environment.bind",
                  input: {
                    workspace: workspace(),
                    conversation,
                    ...(binding
                      ? {
                          root: binding.roots[0],
                          directories: binding.roots.slice(1),
                          fs: {
                            url: binding.url,
                            token: binding.token,
                            session: binding.session,
                            read: binding.read,
                            write: binding.write,
                            client: "ACP",
                          },
                        }
                      : { fs: null }),
                  },
                },
              })
            },
            setCodeMode: async (conversation, enabled) => {
              await nexus.modes({ workspace: workspace(), conversation, patch: { code_mode: enabled } })
            },
            attachMcp: async (attachment) =>
              Schema.decodeUnknownSync(
                Schema.Struct({ tools: Schema.Array(Schema.String), issues: Schema.Array(Schema.String) }),
              )(
                await nexus.manage({
                  payload: {
                    action: "extension.call",
                    name: "editor.mcp.attach",
                    input: {
                      workspace: workspace(),
                      conversation: attachment.conversation,
                      cwd: attachment.cwd,
                      servers: Schema.decodeUnknownSync(Schema.MutableJson)(attachment.servers),
                    },
                  },
                }),
              ),
            detachMcp: async (conversation) => {
              await nexus.manage({
                payload: {
                  action: "extension.call",
                  name: "editor.mcp.detach",
                  input: { workspace: workspace(), conversation },
                },
              })
            },
          },
        )
      })
    }
    if (input.action === "pair") {
      if (Option.isNone(input.url) || Option.isNone(input.model))
        return yield* Effect.fail(new Error("Pairing requires --url and --model."))
      const settings = {
        origin: input.url.value,
        model: input.model.value,
        workspace: Option.getOrElse(input.workspace, () => ""),
        directory: resolve(Option.getOrElse(input.directory, () => process.cwd())),
      }
      const status = yield* Effect.tryPromise(() => nexus.pair(settings))
      if (status.pairing) process.stdout.write(status.pairing.url + "\n" + status.pairing.code + "\n")
      return
    }
    if (input.action === "login") {
      const login = yield* Effect.tryPromise(() => nexus.login())
      process.stdout.write(login.url + "\n")
      return
    }
    if (input.action === "logout") {
      yield* Effect.tryPromise(() => nexus.logout())
      return
    }
    const result = yield* Effect.tryPromise(async () => {
      if (input.action === "extensions") return nexus.extensions()
      if (input.action === "configure") {
        if (Option.isNone(input.json)) throw new Error("Provide an extension configuration change using --json.")

        const { Nexus } = await import("@opencode/schema/nexus")

        return nexus.configureExtension(
          Schema.decodeUnknownSync(Schema.fromJsonString(Nexus.ExtensionChange))(input.json.value) as Parameters<
            typeof nexus.configureExtension
          >[0],
        )
      }
      if (input.action === "manage") {
        if (Option.isNone(input.json)) throw new Error("Provide a Nexus command using --json.")
        const { NexusCommand } = await import("@opencode/protocol/nexus-command")
        return nexus.manage({
          "x-nexus-origin": process.env.NEXUS_URL,
          "x-nexus-member-token": process.env.NEXUS_MEMBER_TOKEN,
          payload: Schema.decodeUnknownSync(Schema.fromJsonString(NexusCommand))(input.json.value) as Parameters<
            typeof nexus.manage
          >[0]["payload"],
        })
      }
      if (input.action === "disconnect") return nexus.disconnect()
      if (input.action === "schedules" || input.action === "memory" || input.action === "mcp")
        return nexus.catalog({ kind: input.action, after: Option.getOrUndefined(input.after) })
      if (input.action === "account") return nexus.account()
      if (input.action === "runners") return nexus.runners()
      return nexus.status()
    })
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  }),
)
