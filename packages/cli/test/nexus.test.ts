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
