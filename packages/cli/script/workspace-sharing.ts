import { parseArgs } from "node:util"
import { readlink } from "node:fs/promises"
import { connect, startWorker, type Command } from "../src/services/workspace-sharing/transport"

// Deliberately separate from the production entrypoint until real run/session semantics are reviewed.
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    "workspace-sharing": { type: "string" },
    human: { type: "boolean" },
    standalone: { type: "boolean" },
    server: { type: "string" },
    id: { type: "string" },
    task: { type: "string" },
    text: { type: "string" },
    "duration-ms": { type: "string", default: "100" },
    "timeout-ms": { type: "string", default: "2000" },
    concurrency: { type: "string", default: "2" },
    "lifetime-ms": { type: "string", default: "60000" },
  },
})

async function main() {
  const root = values["workspace-sharing"]
  if (!root || positionals.length !== 1)
    throw new Error(
      "Usage: bun script/workspace-sharing.ts --workspace-sharing /private/path <serve|submit|query|cancel|result|sessions|ping>",
    )
  if (values.server !== undefined || values.standalone)
    throw new Error("--workspace-sharing cannot be combined with --server or --standalone")
  const op = positionals[0]
  if (op === "serve") {
    const lifetime = Number(values["lifetime-ms"])
    if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 600_000)
      throw new Error("Prototype worker lifetime must be 1–600000 ms")
    const worker = await startWorker(root, { concurrency: Number(values.concurrency) })
    console.log(
      values.human
        ? `Ready. Fake tasks only, concurrency ${Number(values.concurrency)}. Keep this terminal open; Ctrl+C to stop.`
        : JSON.stringify({
            type: "ready",
            root,
            owner: worker.owner,
            executor: "fake-only",
            concurrency: Number(values.concurrency),
          }),
    )
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, lifetime)
      const stop = () => {
        clearTimeout(timer)
        resolve()
      }
      process.once("SIGTERM", stop)
      process.once("SIGINT", stop)
    })
    await worker.stop()
    console.log(
      values.human ? "Stopped. Test worker closed." : JSON.stringify({ type: "stopped", health: worker.health() }),
    )
    return
  }
  const command: Command =
    op === "submit"
      ? { op, text: values.text ?? "", durationMs: Number(values["duration-ms"]) }
      : op === "query" || op === "cancel" || op === "result"
        ? { op, taskId: values.task ?? "" }
        : op === "ping" || op === "sessions"
          ? { op }
          : (() => {
              throw new Error("Unsupported prototype operation")
            })()
  const client = await connect(root, { timeoutMs: Number(values["timeout-ms"]) })
  const reply = await client.request(command, values.id)
  console.log(
    JSON.stringify({
      client: {
        pid: process.pid,
        pidNamespace: await readlink("/proc/self/ns/pid"),
        netNamespace: await readlink("/proc/self/ns/net"),
      },
      reply,
    }),
  )
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
