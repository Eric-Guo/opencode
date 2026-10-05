import { realpath } from "node:fs/promises"
import { FileSharing, type RunInput } from "./owner"

export async function submit(
  root: string,
  input: RunInput,
  options: { requestID?: string; detach?: boolean; signal?: AbortSignal },
) {
  const client = await FileSharing.connect(root)
  const reply = await client.request(
    { op: "run", input: { ...input, directory: await realpath(input.directory) } },
    options.requestID,
  )
  if (reply.error || !reply.task) throw new Error(reply.error ?? "Owner did not return an admitted task")
  const task = reply.task
  process.stderr.write(`Workspace task ${task.id}; Session ${task.sessionID}\n`)
  if (options.detach) {
    process.stdout.write(JSON.stringify(task) + "\n")
    return
  }
  while (!options.signal?.aborted) {
    const current = await client.request({ op: "status", taskID: task.id })
    if (current.error || !current.task) throw new Error(current.error ?? "Task state unavailable")
    if (["queued", "running", "cancelling"].includes(current.task.state)) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      continue
    }
    if (current.task.state === "indeterminate")
      throw new Error(`Task ${task.id}: outcome unknown. ${current.task.reason ?? ""} Do not resubmit with a new ID.`)
    const output = current.task.starts === 0 ? { stdout: "", stderr: "" } : await client.output(task.id)
    process.stdout.write(output.stdout)
    process.stderr.write(output.stderr)
    process.exitCode =
      current.task.state === "completed" ? 0 : current.task.state === "cancelled" ? 130 : current.task.exitCode || 1
    return
  }
  process.stderr.write(
    `Detached from task ${task.id}; it remains owned by the service. Use task status/result/cancel to follow it.\n`,
  )
}
