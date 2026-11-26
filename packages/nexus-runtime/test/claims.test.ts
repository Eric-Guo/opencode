import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExecutorClient } from "@cybros/agent"
import { ClaimJournal } from "../src/claims"
import { ClaimLease } from "../src/claim-control"
import { executorFixture } from "./fixture/executor"

test("a restarted runner delivers saved results and reports interrupted claims without repeating tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-claims-"))
  const commits: unknown[] = []
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/claim")) return Response.json({ claim: { active: !path.includes("/expired/") } })
      if (path.endsWith("/commit")) {
        commits.push(await request.json())
        // Simulate a commit accepted by Nexus before the runner sees the response.
        return Response.json({ error: { code: "task_not_claimable" } }, { status: 409 })
      }
      return new Response(null, { status: 404 })
    },
  })
  try {
    const journal = new ClaimJournal(directory)
    await journal.save({
      run: "run",
      task: "complete",
      token: "saved",
      result: { outcome: "completed", content: "file already written" },
    })
    await journal.save({ run: "run", task: "interrupted", token: "started" })
    await journal.save({ run: "run", task: "expired", token: "expired" })
    const restored = new ClaimJournal(directory)
    const client = new ExecutorClient({ baseURL: server.url.origin, credential: "test-executor" })
    await restored.recover(client, new AbortController().signal)
    expect(commits).toHaveLength(2)
    expect(commits).toContainEqual({ claim_token: "saved", outcome: "completed", content: "file already written" })
    expect(commits).toContainEqual({
      claim_token: "started",
      outcome: "failed",
      content: expect.stringContaining("stopped during execution"),
    })
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("an extension granted in remaining_ms moves the commit retry window past the original park", async () => {
  const fixture = await executorFixture()
  fixture.add("run", "extended", "probe")
  const task = fixture.client.inboxTask("run", "extended")
  const initial = Date.now()
  // A two-second park: the commit retry below crosses it, landing only inside the grant.
  fixture.control.deadline = new Date(initial + 2000).toISOString()
  const claim = await task.claim()
  const lease = new ClaimLease(task, claim, new AbortController().signal)
  fixture.control.route = async (request) => {
    if (!new URL(request.url).pathname.endsWith("/extend")) return undefined
    return Response.json({
      task: fixture.rows.get(JSON.stringify(["run", "extended"]))!,
      claim: { claim_token: claim.claim_token, deadline_at: null, remaining_ms: 120000 },
    })
  }
  let refusals = 0
  fixture.control.refuseCommit = () => {
    refusals++
    return refusals === 1
      ? Response.json({ error: { code: "unavailable" } }, { status: 503, headers: { "Retry-After": "1" } })
      : undefined
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 1050))
    await lease.maintain()
    expect(Math.abs(lease.deadlineAt - (Date.now() + 120000))).toBeLessThan(1000)
    await fixture.journal.settle(
      fixture.client,
      { run: "run", task: "extended", token: claim.claim_token, result: { outcome: "completed", content: "done" } },
      new AbortController().signal,
      () => lease.deadlineAt,
    )
    expect(fixture.commits).toHaveLength(2)
    expect(fixture.results.get(JSON.stringify(["run", "extended"]))).toMatchObject({ content: "done" })
  } finally {
    await lease.close()
    await fixture.close()
  }
}, 15000)
