import { ExecutorClient, type InboxTask, type JsonObject } from "@cybros/agent"
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaimJournal } from "../../src/claims"

export async function executorFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opencode-executor-")))
  const rows = new Map<string, InboxTask>()
  const claims = new Map<string, string>()
  const results = new Map<string, JsonObject>()
  const calls: { method: string; path: string; after: string | null; limit: string | null }[] = []
  const commits: { run: string; task: string; body: JsonObject }[] = []
  const control: {
    beforeClaim?: (run: string, task: string) => Promise<void>
    refuseClaim?: (run: string, task: string) => Response | undefined
    refuseCommit?: (run: string, task: string) => Response | undefined
    lostCommitResponse?: boolean
    deadline?: string | null
    pages?: { tasks: InboxTask[]; next: string | null }[]
    route?: (request: Request) => Promise<Response | undefined>
    committed?: (run: string, task: string, body: JsonObject) => void
  } = {}
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      calls.push({
        method: request.method,
        path: url.pathname,
        after: url.searchParams.get("after"),
        limit: url.searchParams.get("limit"),
      })
      const routed = await control.route?.(request)
      if (routed) return routed
      if (url.pathname.endsWith("/inbox")) {
        const page = control.pages?.[Number(url.searchParams.get("after") ?? 0)]
        return Response.json({
          tasks:
            page?.tasks ??
            [...rows.values()].filter((row) => !results.has(JSON.stringify([row.run_public_id, row.task_key]))),
          pagination: { next_after: page?.next ?? null },
        })
      }
      const segments = url.pathname.split("/").map(decodeURIComponent)
      const run = segments.at(-3)!
      const task = segments.at(-2)!
      const key = JSON.stringify([run, task])
      const row = rows.get(key)
      if (!row) return Response.json({ error: { code: "not_found" } }, { status: 404 })
      if (url.pathname.endsWith("/claim")) {
        if (request.method === "GET")
          return Response.json({
            claim: { active: claims.get(key) === request.headers.get("Claim-Token") && !results.has(key) },
          })
        const refusal = control.refuseClaim?.(run, task)
        if (refusal) return refusal
        await control.beforeClaim?.(run, task)
        if (claims.has(key)) return Response.json({ error: { code: "already_claimed" } }, { status: 409 })
        const token = crypto.randomUUID()
        claims.set(key, token)
        row.claimed = true
        return Response.json({
          task: row,
          claim: {
            claim_token: token,
            deadline_at: control.deadline === undefined ? new Date(Date.now() + 60000).toISOString() : control.deadline,
          },
        })
      }
      if (url.pathname.endsWith("/commit")) {
        const body = (await request.json()) as JsonObject
        commits.push({ run, task, body })
        if (body.claim_token !== claims.get(key))
          return Response.json({ error: { code: "not_claimant" } }, { status: 409 })
        const refusal = control.refuseCommit?.(run, task)
        if (refusal) return refusal
        results.set(key, body)
        control.committed?.(run, task, body)
        if (control.lostCommitResponse) {
          control.lostCommitResponse = false
          return Response.json({ error: { code: "response_lost" } }, { status: 503 })
        }
        return Response.json({
          task: {
            key: task,
            kind: "tool_call",
            status: body.outcome === "failed" ? "failed" : "completed",
            lifetime: "run",
            wake: "none",
            after: [],
            waiting_on: [],
            visibility: "public",
            approval: null,
            result: { content: body.content, is_error: body.is_error ?? false },
          },
        })
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 })
    },
  })
  const journal = new ClaimJournal(join(directory, "claims"))
  const add = (run: string, task: string, tool: string, fields: Partial<InboxTask> = {}) => {
    const row: InboxTask = {
      run_public_id: run,
      task_key: task,
      tool_name: tool,
      executor_context: { "opencode.directory": directory },
      kind: "tool_call",
      workspace_public_id: "workspace",
      conversation_public_id: "conversation",
      parent_public_id: null,
      prompt: null,
      options: null,
      multi: null,
      fields: null,
      tool_alias: null,
      tool_input: {},
      scope: null,
      tool_call_id: null,
      started_at: null,
      deadline_at: null,
      timeout_ms: null,
      claimed: false,
      addressed_to: { role: "runner", executor_public_id: "executor", presence: "online", last_seen_at: null },
      target: null,
      effect_profile: null,
      ...fields,
    }
    rows.set(JSON.stringify([run, task]), row)
    return row
  }
  return {
    server,
    directory,
    journal,
    control,
    add,
    rows,
    claims,
    results,
    calls,
    commits,
    client: new ExecutorClient({ baseURL: server.url.origin, credential: "fixture-executor" }),
    pending: () => readdir(join(directory, "claims")),
    async close() {
      server.stop(true)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
