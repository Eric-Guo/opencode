import { expect, test } from "bun:test"
import type { NexusCommand } from "@opencode/protocol/nexus-command"
import { runJobs } from "../src/jobs"

test("conversation jobs preserve cursor scope, edit the fetched version and send multiline prompts", async () => {
  const commands: (typeof NexusCommand.Type)[] = []
  const job = {
    public_id: "job",
    name: null,
    prompt: "Original",
    status: "active",
    next_run_at: null,
    lock_version: 7,
    rule: { kind: "daily", local_time: "09:00", time_zone: "UTC" },
    last_error_code: null,
    last_enqueued_at: null,
    last_execution: null,
  }
  const run = (words: string[], json = false) =>
    runJobs("chat", words, { workspace: "work", json }, async (command) => {
      commands.push(command)
      if (command.action === "schedule.list") return { items: [job], next_after: "page2" }
      if (command.action === "schedule.executions")
        return {
          items: [
            { child_conversation_public_id: "child", status: "completed", scheduled_for: "2030-01-01T09:00:00Z" },
          ],
          next_after: "page3",
        }
      return job
    })
  expect(await run(["list", "page1"])).toContain("More jobs: list page2")
  expect(await run(["history", "job", "page2"])).toContain("child · completed")
  expect(await run(["edit", "job", "prompt", "one\ntwo"])).toContain("Rule:")
  expect(commands).toEqual([
    { action: "schedule.list", workspace: "work", conversation: "chat", after: "page1" },
    { action: "schedule.executions", workspace: "work", conversation: "chat", id: "job", after: "page2" },
    { action: "schedule.read", workspace: "work", conversation: "chat", id: "job" },
    { action: "schedule.update", workspace: "work", conversation: "chat", id: "job", version: 7, prompt: "one\ntwo" },
  ])
  expect(JSON.parse(await run(["create", "daily", "09:00", "UTC", "one\ntwo"], true))).toEqual(job)
  expect(commands.at(-1)).toMatchObject({
    action: "schedule.create",
    prompt: "one\ntwo",
    rule: job.rule,
    key: expect.any(String),
  })
  for (const action of ["pause", "resume", "run", "cancel", "show"]) await run([action, "job"])
  expect(commands.slice(-5).map((command) => command.action)).toEqual([
    "schedule.pause",
    "schedule.resume",
    "schedule.run",
    "schedule.cancel",
    "schedule.read",
  ])
  await expect(run(["edit", "job", "daily", "25:00", "UTC"])).rejects.toThrow()
  expect(commands.at(-1)?.action).toBe("schedule.read")
})
