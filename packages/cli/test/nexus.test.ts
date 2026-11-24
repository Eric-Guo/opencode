import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Command } from "effect/cli"
import { Commands } from "../src/commands/commands"

test("Nexus production commands parse one-shot policy and API-key stdin without requiring a prompt", async () => {
  const received: unknown[] = []
  const command = Commands.commands.nexus.spec.pipe(
    Command.withHandler((input) =>
      Effect.sync(() => {
        received.push({
          action: input.action,
          prompt: Option.getOrUndefined(input.prompt),
          code: Option.getOrUndefined(input.codeMode),
          format: input.outputFormat,
          print: input.print,
          keys: input.apiKeyStdin,
        })
      }),
    ),
  )
  for (const args of [
    ["run", "Inspect this project", "--no-code-mode", "--output-format", "json", "-p"],
    ["pair", "--api-key-stdin"],
    ["settings", "--json", '{"subagent_default":false}'],
  ])
    await Effect.runPromise(
      Command.runWith(command, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
    )
  expect(received).toEqual([
    { action: "run", prompt: "Inspect this project", code: false, format: "json", print: true, keys: false },
    { action: "pair", prompt: undefined, code: undefined, format: "text", print: false, keys: true },
    { action: "settings", prompt: undefined, code: undefined, format: "text", print: false, keys: false },
  ])
})

test("Nexus ACP parses launch mode, model and runner independently of pairing options", async () => {
  const received: unknown[] = []
  const command = Commands.commands.nexus.spec.pipe(
    Command.withHandler((input) =>
      Effect.sync(() => {
        received.push({
          action: input.action,
          mode: Option.getOrUndefined(input.mode),
          model: Option.getOrUndefined(input.model),
          runner: Option.getOrUndefined(input.runner),
        })
      }),
    ),
  )
  await Effect.runPromise(
    Command.runWith(command, { version: "test" })([
      "acp",
      "--mode",
      "rules",
      "--model",
      "provider/model",
      "--runner",
      "remote",
    ]).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(received).toEqual([{ action: "acp", mode: "rules", model: "provider/model", runner: "remote" }])
})

test("jobs, web-fetch and persona preserve their positional arguments and flags", async () => {
  const parsed: unknown[] = []
  const command = Commands.commands.nexus.spec.pipe(
    Command.withHandler((input) =>
      Effect.sync(() => {
        parsed.push([input.action, Option.getOrUndefined(input.prompt), input.words, input.raw])
      }),
    ),
  )
  for (const argv of [
    ["jobs", "chat", "create", "every", "2h", "Review the build"],
    ["web-fetch", "https://example.test", "--raw"],
    ["persona", "set", "-"],
  ])
    await Effect.runPromise(
      Command.runWith(command, { version: "test" })(argv).pipe(Effect.provide(NodeServices.layer)),
    )
  expect(parsed).toEqual([
    ["jobs", "chat", ["create", "every", "2h", "Review the build"], false],
    ["web-fetch", "https://example.test", [], true],
    ["persona", "set", ["-"], false],
  ])
})
