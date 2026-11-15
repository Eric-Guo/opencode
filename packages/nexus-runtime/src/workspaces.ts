import type { Client, RequestOptions, WorkspaceSummary } from "@cybros/agent"

/** Selection is a creation preference, never a move of an existing host. */
export class Workspaces {
  constructor(private readonly member: Client) {}

  async list(options: RequestOptions = {}) {
    const pages = await Promise.all(
      [true, false].map(async (dedicated_to_current_agent) => {
        const rows: WorkspaceSummary[] = []
        let after: string | undefined

        do {
          const page = await this.member.workspaces.list({ dedicated_to_current_agent, after, limit: 100 }, options)
          rows.push(...page.items.filter((row) => row.state === "active"))
          after = page.next_after ?? undefined
        } while (after)

        return rows
      }),
    )

    return [...new Map(pages.flat().map((row) => [row.public_id, row])).values()]
  }

  async require(id: string, options: RequestOptions = {}) {
    const workspace = await this.member.workspaces.fetch(id, options)

    if (
      workspace.state !== "active" ||
      (workspace.dedicated && !(await this.list(options)).some((row) => row.public_id === id))
    )
      throw new Error("Select an active workspace owned by this agent or a visible shared workspace.")

    return workspace
  }
}
