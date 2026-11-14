import type { ApprovalRule, TaskDetail } from "@cybros/agent"

export type ApprovalGrant = {
  rule: ApprovalRule
  run: string
  task: string
  conversation: string | null
  granted_at: string
}

/** Preserve the held argument's raw bytes: an exact grant must not silently become a glob. */
export function approvalGrant(detail: TaskDetail, match?: string): ApprovalRule {
  if (detail.task.status !== "needs_approval") throw new Error("Only a call held for approval can create a grant.")

  const remote = detail.task.target?.kind === "mcp"
  const tool = (remote ? detail.task.tool_alias : null) ?? detail.task.tool_name

  if (!tool) throw new Error("The held task does not name a tool.")
  if (remote && /[*?|]/.test(tool)) throw new Error("The MCP callable contains pattern characters; approve it once.")

  const path = remote
    ? undefined
    : { bash: "command", start_process: "command", write: "path", edit: "path", web_fetch: "url" }[tool]

  if (!path) {
    if (match !== undefined) throw new Error("This tool is granted whole; --match requires a command, path or site.")

    return { tool, verdict: "allow" }
  }
  const value = detail.tool_input?.[path]

  if (typeof value !== "string" || !value.trim()) throw new Error("The held call has no " + path + " text.")
  if (!value.isWellFormed()) throw new Error("The held " + path + " is not valid UTF-8 text.")
  if (path === "url") {
    const original = /^(https?):\/\/([^/?#]+)/i.exec(value)
    const parsed = URL.parse(value)

    if (
      !original ||
      !parsed?.hostname ||
      parsed.username ||
      parsed.password ||
      /[*?@]/.test(original[2]) ||
      /[^\x21-\x7e]/.test(value)
    )
      throw new Error("The held URL must have an HTTP(S) host without credentials or wildcards.")

    const site = original[1] + "://" + original[2]

    if (match !== undefined && match !== site && match !== site + "/")
      throw new Error("--match must equal the held URL's literal site.")

    return { tool, path, match: site + "/*", verdict: "allow" }
  }
  if (match === undefined) {
    if (/[*?]/.test(value))
      throw new Error("The held argument contains wildcard characters; grant a literal prefix instead.")

    return { tool, path, match: value, verdict: "allow" }
  }
  const separator = path === "command" ? " " : "/"
  const prefix = match.endsWith(separator) ? match.slice(0, -1) : match

  if (!prefix.trim() || /[*?]/.test(prefix) || !value.startsWith(prefix + separator))
    throw new Error("--match must be a literal whole-token prefix of the held " + path + ".")

  return { tool, path, match: prefix + separator + "*", verdict: "allow" }
}
