import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExecutorClient } from "@cybros/agent"
import { ClaimJournal } from "../src/claims"

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
