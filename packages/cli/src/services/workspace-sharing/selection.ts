import { Option } from "effect"
import { Commands } from "../../commands/commands"
import type { Spec } from "../../framework/spec"

/** Call only with the actual command node and its successfully parsed input. */
export function isWorkspaceClient(node: Spec.Any, input: unknown) {
  if (
    node !== Commands.commands.run &&
    node !== Commands.commands.task &&
    node !== Commands.commands.session.commands.list
  )
    return false
  return Option.isSome((input as { workspaceSharing: Option.Option<string> }).workspaceSharing)
}
