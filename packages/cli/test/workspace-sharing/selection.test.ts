import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Command } from "effect/cli"
import { Commands } from "../../src/commands/commands"
import type { Spec } from "../../src/framework/spec"
import { isWorkspaceClient } from "../../src/services/workspace-sharing/selection"

async function parsed(node: Spec.Any, args: string[]) {
  const selected: boolean[] = []
  const command = node.spec.pipe(
    Command.withHandler((input) =>
      Effect.sync(() => {
        selected.push(isWorkspaceClient(node, input))
      }),
    ),
  )
  await Effect.runPromise(Command.runWith(command, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)))
  return selected
}

test("only parsed sharing client commands skip SSO", async () => {
  expect(await parsed(Commands.commands.run, ["--workspace-sharing", "/private/spool", "hello"])).toEqual([true])
  expect(await parsed(Commands.commands.task, ["status", "one", "--workspace-sharing", "/private/spool"])).toEqual([
    true,
  ])
  expect(await parsed(Commands.commands.session.commands.list, ["--workspace-sharing", "/private/spool"])).toEqual([
    true,
  ])
  expect(await parsed(Commands.commands.serve, ["--workspace-sharing", "/private/spool"])).toEqual([false])
})

test("ordinary run, standalone, explicit server and flag-like prompt text keep SSO", async () => {
  expect(await parsed(Commands.commands.run, ["hello"])).toEqual([false])
  expect(await parsed(Commands.commands.run, ["--standalone", "hello"])).toEqual([false])
  expect(await parsed(Commands.commands.run, ["--server", "http://127.0.0.1:4000", "hello"])).toEqual([false])
  expect(await parsed(Commands.commands.run, ["--", "--workspace-sharing", "/private/spool"])).toEqual([false])
  expect(await parsed(Commands.commands.run, ["say --workspace-sharing /private/spool"])).toEqual([false])
  expect(await parsed(Commands.commands.service.commands.status, [])).toEqual([false])
})
