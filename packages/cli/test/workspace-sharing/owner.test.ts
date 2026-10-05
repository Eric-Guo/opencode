import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileSharing, type Adapter, type RunTask } from "../../src/services/workspace-sharing/owner"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(override: Partial<Adapter> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-sharing-owner-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const runs: RunTask[] = []
  const adapter: Adapter = {
    async run(task, signal) {
      runs.push(task)
      return new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ state: "completed", exitCode: 0, stdout: `answer:${task.input.message}`, stderr: "" }),
          100,
        )
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            resolve({ state: "cancelled", exitCode: 130, stdout: "", stderr: "" })
          },
          { once: true },
        )
      })
    },
    async sessions() {
      return runs.map((task) => ({ id: task.sessionID, title: task.input.message }))
    },
  }
  Object.assign(adapter, override)
  const lease = await FileSharing.acquire(path.join(root, "spool"), root)
  const owner = await FileSharing.start(lease, adapter, { pollMs: 5 })
  cleanups.push(async () => {
    await owner.stop()
    await lease.release()
  })
  const client = await FileSharing.connect(path.join(root, "spool"), { pollMs: 5, timeoutMs: 1000 })
  const input = { directory: root, message: "hello", format: "json" as const, auto: false }
  return { root, lease, owner, client, input, runs }
}

async function terminal(client: Awaited<ReturnType<typeof FileSharing.connect>>, taskID: string) {
  for (let i = 0; i < 100; i++) {
    const reply = await client.request({ op: "status", taskID })
    if (reply.task && !["queued", "running", "cancelling"].includes(reply.task.state)) return reply.task
    await Bun.sleep(10)
  }
  throw new Error("Task did not finish")
}

test("run binds durable task/session/message IDs before adapter execution without a second database", async () => {
  const { root, client, input, runs } = await fixture()
  const admitted = await client.request({ op: "run", input }, "task-one")
  expect(admitted.task?.sessionID.startsWith("ses_")).toBe(true)
  expect(admitted.task?.messageID.startsWith("msg_")).toBe(true)
  expect((await terminal(client, "task-one")).state).toBe("completed")
  expect(runs).toHaveLength(1)
  expect((await client.output("task-one")).stdout).toBe("answer:hello")
  expect((await readdir(path.join(root, "spool"))).some((name) => /\.(sqlite|db)$/.test(name))).toBe(false)
})

test("same request retry never reruns, and changed payload conflicts", async () => {
  const { client, input, runs } = await fixture()
  await Promise.all([
    client.request({ op: "run", input }, "same-task"),
    client.request({ op: "run", input }, "same-task"),
  ])
  await terminal(client, "same-task")
  await client.request({ op: "run", input }, "same-task")
  expect(runs).toHaveLength(1)
  await expect(client.request({ op: "run", input: { ...input, message: "different" } }, "same-task")).rejects.toThrow(
    "conflict",
  )
})

test("two active tasks bound concurrency and cancellation remains task-specific", async () => {
  const { client, input } = await fixture()
  await Promise.all([1, 2, 3].map((i) => client.request({ op: "run", input }, `bound-${i}`)))
  const status = await client.request({ op: "ping" })
  expect(status.active).toBe(2)
  expect((await client.request({ op: "status", taskID: "bound-3" })).task?.state).toBe("queued")
  await client.request({ op: "cancel", taskID: "bound-2" })
  expect((await terminal(client, "bound-2")).state).toBe("cancelled")
  expect((await terminal(client, "bound-1")).state).toBe("completed")
  expect((await terminal(client, "bound-3")).state).toBe("completed")
})

test("worker rejects conflicting startup and directories outside its workspace", async () => {
  const { root, input, client } = await fixture()
  await expect(FileSharing.acquire(path.join(root, "spool"), root)).rejects.toThrow("owner")
  expect(
    (await client.request({ op: "run", input: { ...input, directory: tmpdir() } }, "bad-directory")).error,
  ).toContain("workspace")
})

test("session history uses the adapter and keeps model/tool permissions explicit", async () => {
  const { input, client, runs, root } = await fixture()
  await client.request({ op: "run", input }, "history-task")
  await terminal(client, "history-task")
  const reply = await client.request({ op: "sessions", directory: root, limit: 100 })
  expect(reply.sessions).toEqual([{ id: runs[0]?.sessionID, title: "hello" }])
  expect(runs[0]?.input.auto).toBe(false)
})

test("shutdown settles cancellation before owner release and does not replay on reconnect", async () => {
  const { input, client, owner, lease, root, runs } = await fixture()
  await client.request({ op: "run", input }, "shutdown-task")
  await owner.stop()
  await lease.release()
  await expect(client.request({ op: "ping" })).rejects.toThrow("unavailable")
  const nextLease = await FileSharing.acquire(path.join(root, "spool"), root)
  const nextOwner = await FileSharing.start(
    nextLease,
    {
      run: async () => {
        throw new Error("must not replay")
      },
      sessions: async () => [],
    },
    { pollMs: 5 },
  )
  cleanups.push(async () => {
    await nextOwner.stop()
    await nextLease.release()
  })
  const next = await FileSharing.connect(path.join(root, "spool"), { pollMs: 5 })
  expect((await next.request({ op: "status", taskID: "shutdown-task" })).task?.state).toBe("cancelled")
  expect(runs.length).toBeLessThanOrEqual(1)
})

test("read-only polling leaves no permanent request backlog", async () => {
  const { root, client } = await fixture()
  for (let i = 0; i < 50; i++) await client.request({ op: "ping" })
  expect(await readdir(path.join(root, "spool", "requests"))).toEqual([])
  expect(await readdir(path.join(root, "spool", "replies"))).toEqual([])
})

test("unknown execution outcomes block further admission instead of oversubscribing", async () => {
  const { input, client } = await fixture({
    run: async () => ({
      state: "indeterminate",
      exitCode: 1,
      stdout: "",
      stderr: "",
      reason: "settlement unavailable",
    }),
  })
  await client.request({ op: "run", input }, "unknown-one")
  expect((await terminal(client, "unknown-one")).state).toBe("indeterminate")
  expect((await client.request({ op: "run", input }, "do-not-run")).error).toBe("settlement unavailable")
})
