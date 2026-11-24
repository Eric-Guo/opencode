import type { Client, RequestOptions } from "@cybros/agent"

export async function listTerminalRuns(
  workspace: ReturnType<Client["workspace"]>,
  after?: string,
  options?: RequestOptions,
) {
  const page = await workspace.runs.list({ kind: "standalone", order: "desc", after, limit: 20 }, options)
  const rows = await Promise.all(
    page.items.map(async (run) => {
      const detail = await workspace
        .run(run.public_id)
        .fetch(options)
        .catch((error: unknown) => {
          // The UI bridge and runtime can load separate copies of the SDK.
          if (error instanceof Error && "status" in error && error.status === 404) return null
          throw error
        })

      if (detail?.tasks.length !== 1) return null
      const task = detail.tasks[0]

      // OpenCode creates standalone terminals with "terminal". Rho uses the SDK's "call_tool".
      if (task.tool_name !== "terminal" || !["terminal", "call_tool"].includes(task.key)) return null
      return {
        run: run.public_id,
        task: task.key,
        status: task.status,
        created: run.created_at ?? detail.created_at ?? null,
      }
    }),
  )

  return { items: rows.filter((row) => row !== null), next: page.next_after }
}
