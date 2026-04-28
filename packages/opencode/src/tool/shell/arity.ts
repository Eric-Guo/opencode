import { BashArity } from "@/permission/arity"
import type { ShellKind } from "./id"

export namespace ShellArity {
  export function prefix(tokens: string[], _shellType: ShellKind.ID) {
    return BashArity.prefix(tokens)
  }
}
