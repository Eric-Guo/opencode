import { Wildcard } from "@/util"
import { ShellToolID } from "@/tool/shell/id"

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const next = ShellToolID.normalize(permission)
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(next, ShellToolID.normalize(rule.permission)) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
