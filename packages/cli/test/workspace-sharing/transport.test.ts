import { afterEach, expect, test } from "bun:test"
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { connect, initialize, startWorker } from "../../src/services/workspace-sharing/transport"

const roots: string[] = []
const workers: Awaited<ReturnType<typeof startWorker>>[] = []

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(concurrency = 2) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-sharing-test-")))
  roots.push(root)
  await initialize(root)
  const worker = await startWorker(root, { concurrency, pollMs: 5 })
  workers.push(worker)
  const client = await connect(root, { timeoutMs: 1_000, pollMs: 5 })
  return { root, worker, client }
}

async function terminal(client: Awaited<ReturnType<typeof connect>>, taskId: string) {
  for (let count = 0; count < 200; count++) {
    const reply = await client.request({ op: "result", taskId })
    if (reply.task?.state !== "queued" && reply.task?.state !== "running") return reply.task
    await Bun.sleep(5)
  }
  throw new Error("Task did not finish")
}

test("submit, query, result and sessions use one worker database", async () => {
  const { root, client } = await fixture()
  const reply = await client.request({ op: "submit", text: "hello", durationMs: 20 }, "request-one")
  expect(reply.task?.id).toBe("request-one")
  const done = await terminal(client, "request-one")
  expect(done?.state).toBe("completed")
  expect(done?.result).toBe("fake:hello")
  expect((await client.request({ op: "sessions" })).sessions).toEqual(["session-request-one"])
  expect((await readdir(root)).filter((name) => name.endsWith(".sqlite"))).toEqual(["tasks.sqlite"])
})

test("identical retries and concurrent duplicate requests execute once; conflicting retries fail", async () => {
  const { client } = await fixture()
  const input = { op: "submit" as const, text: "once", durationMs: 20 }
  const replies = await Promise.all([client.request(input, "same-id"), client.request(input, "same-id")])
  expect(replies[0]).toEqual(replies[1])
  await expect(client.request({ ...input, text: "different" }, "same-id")).rejects.toThrow("conflict")
  expect((await terminal(client, "same-id"))?.starts).toBe(1)
})

test("bounded concurrency is two and a disconnected submitter does not own the task", async () => {
  const { root, client } = await fixture()
  await Promise.all(
    [1, 2, 3].map((i) => client.request({ op: "submit", text: String(i), durationMs: 120 }, `bound-${i}`)),
  )
  const observer = await connect(root, { timeoutMs: 1_000, pollMs: 5 })
  const states = await Promise.all([1, 2, 3].map((i) => observer.request({ op: "query", taskId: `bound-${i}` })))
  expect(states.filter((item) => item.task?.state === "running")).toHaveLength(2)
  expect(states.filter((item) => item.task?.state === "queued")).toHaveLength(1)
  const done = await Promise.all([1, 2, 3].map((i) => terminal(observer, `bound-${i}`)))
  expect(done.every((task) => task?.state === "completed")).toBe(true)
  expect((await observer.request({ op: "ping" })).maxActive).toBe(2)
})

test("cancel queued and running tasks targets only the named task", async () => {
  const { client } = await fixture(1)
  await client.request({ op: "submit", text: "a", durationMs: 300 }, "cancel-running")
  await client.request({ op: "submit", text: "b", durationMs: 300 }, "cancel-queued")
  await client.request({ op: "submit", text: "c", durationMs: 10 }, "keep-task")
  expect((await client.request({ op: "cancel", taskId: "cancel-queued" })).task?.state).toBe("cancelled")
  expect((await client.request({ op: "cancel", taskId: "cancel-running" })).task?.state).toBe("cancelled")
  expect((await terminal(client, "keep-task"))?.state).toBe("completed")
  expect((await client.request({ op: "cancel", taskId: "keep-task" })).task?.state).toBe("completed")
  expect((await client.request({ op: "cancel", taskId: "unknown" })).error).toBe("task_not_found")
})

test("an existing owner blocks another worker, regardless of age or namespace metadata", async () => {
  const { root } = await fixture()
  await expect(startWorker(root)).rejects.toThrow("owner")
  const owner = JSON.parse(await readFile(path.join(root, "worker.lock", "owner.json"), "utf8"))
  owner.startedAt = 0
  owner.pidNamespace = "different-domain"
  await writeFile(path.join(root, "worker.lock", "owner.json"), JSON.stringify(owner), { mode: 0o600 })
  await expect(startWorker(root)).rejects.toThrow("owner")
})

test("stopped service fails closed and never starts a replacement", async () => {
  const { root, worker } = await fixture()
  const client = await connect(root, { timeoutMs: 40, pollMs: 5 })
  await worker.stop()
  await expect(client.request({ op: "ping" })).rejects.toThrow("unavailable")
  expect(await readdir(root)).not.toContain("worker.lock")
})

test("partial writes are ignored; malformed and traversal input cannot become executable tasks", async () => {
  const { root, client } = await fixture()
  await writeFile(path.join(root, "requests", ".half.tmp"), '{"op":"submit"', { mode: 0o600 })
  await writeFile(path.join(root, "requests", "invalid.json"), '{"op":"shell","command":"echo unsafe"}', {
    mode: 0o600,
  })
  await Bun.sleep(20)
  expect((await client.request({ op: "sessions" })).sessions).toEqual([])
  await expect(client.request({ op: "query", taskId: "../../escape" })).rejects.toThrow("identifier")
  await expect(client.request({ op: "submit", text: "x", durationMs: 1 }, "../bad")).rejects.toThrow("identifier")
})

test("symlinks and broad permissions are rejected for roots and request files", async () => {
  const { root, client } = await fixture()
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-sharing-links-")))
  roots.push(parent)
  await symlink(root, path.join(parent, "alias"))
  await expect(connect(path.join(parent, "alias"))).rejects.toThrow("symlink")
  await chmod(root, 0o755)
  await expect(connect(root)).rejects.toThrow("private")
  await chmod(root, 0o700)
  await symlink(path.join(root, "worker.lock", "owner.json"), path.join(root, "requests", "symlink-request.json"))
  await expect(client.request({ op: "ping" }, "symlink-request")).rejects.toThrow("regular")
})

test("request files are immutable atomic publications with 0600 permissions", async () => {
  const { root, client } = await fixture()
  await client.request({ op: "ping" }, "atomic-one")
  const files = await readdir(path.join(root, "requests"))
  expect(files).toEqual(["atomic-one.json"])
  const value = JSON.parse(await readFile(path.join(root, "requests", "atomic-one.json"), "utf8"))
  expect(value.id).toBe("atomic-one")
  expect(value.ownerId).toBeString()
})

test("maximum Chinese and escaped text remains readable after completion", async () => {
  const { client } = await fixture()
  for (const [index, text] of ["中".repeat(4096), "\u0000".repeat(4096)].entries()) {
    const taskId = `large-${index}`
    await client.request({ op: "submit", text, durationMs: 0 }, taskId)
    const done = await terminal(client, taskId)
    expect(done?.result).toBe(`fake:${text}`)
  }
})

test("duplicate retry waits for the publication staging link to disappear", async () => {
  const { root, client } = await fixture()
  const command = { op: "submit" as const, text: "once", durationMs: 0 }
  await client.request(command, "transient-link")
  const stage = path.join(root, "requests", ".staging.tmp")
  await link(path.join(root, "requests", "transient-link.json"), stage)
  const timer = setTimeout(() => void unlink(stage), 30)
  try {
    expect((await client.request(command, "transient-link")).task?.id).toBe("transient-link")
  } finally {
    clearTimeout(timer)
  }
  expect((await terminal(client, "transient-link"))?.starts).toBe(1)
})

test("published files have private modes and a stable single link", async () => {
  const { root, client } = await fixture()
  await client.request({ op: "ping" }, "private-mode")
  for (const relative of [
    "requests/private-mode.json",
    "replies/private-mode.json",
    "tasks.sqlite",
    "worker.lock/owner.json",
  ]) {
    const value = await stat(path.join(root, relative))
    expect(value.mode & 0o777).toBe(0o600)
    expect(value.nlink).toBe(1)
  }
})

test("task capacity is bounded without deleting history", async () => {
  const { client } = await fixture()
  await Promise.all(
    Array.from({ length: 128 }, (_, index) =>
      client.request({ op: "submit", text: "x", durationMs: 0 }, `limit-${index}`),
    ),
  )
  expect((await client.request({ op: "submit", text: "too many", durationMs: 0 }, "over-limit")).error).toBe(
    "prototype_task_limit",
  )
  expect((await client.request({ op: "sessions" })).sessions).toHaveLength(128)
})

test("concurrent worker starts elect one owner", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-sharing-election-")))
  roots.push(root)
  const attempts = await Promise.allSettled([startWorker(root), startWorker(root)])
  const elected = attempts.filter((item) => item.status === "fulfilled")
  expect(elected).toHaveLength(1)
  expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1)
  if (elected[0]?.status === "fulfilled") workers.push(elected[0].value)
})

test("clean restart preserves history but refuses stale clients and late envelopes", async () => {
  const { root, worker, client } = await fixture()
  await client.request({ op: "submit", text: "old", durationMs: 0 }, "old-task")
  await terminal(client, "old-task")
  const oldOwner = client.owner.id
  await worker.stop()
  const replacement = await startWorker(root, { pollMs: 5 })
  workers.push(replacement)
  await expect(client.request({ op: "ping" })).rejects.toThrow("owner changed")
  await writeFile(
    path.join(root, "requests", "late-old.json"),
    JSON.stringify({
      version: 1,
      id: "late-old",
      ownerId: oldOwner,
      command: { op: "submit", text: "must not run", durationMs: 0 },
    }),
    { mode: 0o600 },
  )
  const next = await connect(root, { pollMs: 5 })
  expect((await next.request({ op: "result", taskId: "old-task" })).task?.result).toBe("fake:old")
  expect((await next.request({ op: "query", taskId: "late-old" })).error).toBe("task_not_found")
  await expect(next.request({ op: "submit", text: "old", durationMs: 0 }, "old-task")).rejects.toThrow("conflict")
})

test("crashed worker leaves owner intact and cannot be replaced automatically", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-sharing-crash-")))
  roots.push(root)
  const proc = Bun.spawn(
    [
      process.execPath,
      "../../script/workspace-sharing.ts",
      "--workspace-sharing",
      root,
      "serve",
      "--lifetime-ms",
      "60000",
    ],
    {
      cwd: import.meta.dir,
      env: { HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const reader = proc.stdout.getReader()
  try {
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value)).toContain('"type":"ready"')
    const client = await connect(root, { timeoutMs: 50, pollMs: 5 })
    proc.kill("SIGKILL")
    await proc.exited
    await expect(client.request({ op: "ping" }, "dead-ping")).rejects.toThrow("outcome unknown")
    await expect(startWorker(root)).rejects.toThrow("owner")
    expect(await readdir(root)).toContain("worker.lock")
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL")
    await proc.exited
    reader.releaseLock()
  }
})

test("experimental CLI rejects conflicting connection modes before creating service state", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-sharing-cli-")))
  roots.push(root)
  const proc = Bun.spawn(
    [process.execPath, "../../script/workspace-sharing.ts", "--workspace-sharing", root, "--standalone", "serve"],
    { cwd: import.meta.dir, env: { HOME: root, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
  )
  const error = await new Response(proc.stderr).text()
  expect(await proc.exited).toBe(1)
  expect(error).toContain("cannot be combined")
  expect((await readdir(root)).filter((name) => name !== ".bun")).toEqual([])
})

test("SQLite sidecar symlinks are rejected before database opening", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-sharing-sidecar-")))
  roots.push(root)
  await initialize(root)
  const outside = path.join(root, "untouched.txt")
  await writeFile(outside, "unchanged", { mode: 0o600 })
  await symlink(outside, path.join(root, "tasks.sqlite-wal"))
  await expect(startWorker(root)).rejects.toThrow("regular")
  expect(await readFile(outside, "utf8")).toBe("unchanged")
})
