import { OpenCode } from "@opencode/client/promise"
import { Service, type Endpoint } from "@opencode/client/effect/service"
import { spawn } from "node:child_process"
import { findSession, parseSessionTargetModel } from "../../session-target"
import { selfCommand } from "../../util/process"
import type { Adapter, Result, RunTask } from "./owner"

const outputLimit = 256 * 1024

export function cliAdapter(endpoint: Endpoint, executable = selfCommand()): Adapter {
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const request = () => ({ signal: AbortSignal.timeout(10_000) })
  const interrupt = async (task: RunTask) => {
    await client.session.inbox.cancel({ sessionID: task.sessionID, inboxID: task.messageID }, request()).catch(() => {})
    await client.session.interrupt({ sessionID: task.sessionID }, request())
  }
  return {
    async sessions(directory, limit) {
      const location = await client.location.get({ location: { directory } }, request())
      const page = await client.session.list(
        { project: location.project.id, parentID: null, order: "desc", limit },
        request(),
      )
      return page.data.map((session) => ({
        id: session.id,
        title: session.title,
        time: { created: session.time.created, updated: session.time.updated },
        projectID: session.projectID,
        location: { directory: session.location.directory },
      }))
    },
    async run(task, signal): Promise<Result> {
      if (signal.aborted) return { state: "cancelled", exitCode: 130, stdout: "", stderr: "" }
      if (await findSession(client, task.sessionID, AbortSignal.timeout(10_000)))
        throw new Error("Bound Session already exists before first dispatch; refusing to adopt or replay it")
      await client.session.create(
        {
          id: task.sessionID,
          location: { directory: task.input.directory },
          title: task.input.title,
          agent: task.input.agent,
          model: parseSessionTargetModel(task.input.model),
        },
        request(),
      )
      if (signal.aborted) return { state: "cancelled", exitCode: 130, stdout: "", stderr: "" }
      const [program, ...prefix] = executable
      if (!program) throw new Error("Missing workspace client executable")
      const args = [
        ...prefix,
        "run",
        "--server",
        endpoint.url,
        "--session",
        task.sessionID,
        "--message-id",
        task.messageID,
        "--format",
        task.input.format,
        ...(task.input.model ? ["--model", task.input.model] : []),
        ...(task.input.agent ? ["--agent", task.input.agent] : []),
        ...(task.input.thinking ? ["--thinking"] : []),
        ...(task.input.auto ? ["--auto"] : []),
      ]
      // Provider credentials remain owner-local. In particular, do not forward SSO or Env.session().
      const env = Object.fromEntries(
        [
          "PATH",
          "HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_CACHE_HOME",
          "XDG_STATE_HOME",
          "TMPDIR",
          "TMP",
          "TEMP",
          "LANG",
          "LC_ALL",
          "OPENCODE_CONFIG_DIR",
        ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      )
      const child = spawn(program, args, {
        cwd: task.input.directory,
        env: {
          ...env,
          OPENCODE_PASSWORD: endpoint.auth?.type === "basic" ? endpoint.auth.password : "",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_CLIENT: "workspace-sharing-client",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
      const output = { stdout: "", stderr: "", overflow: false, sizes: { stdout: 0, stderr: 0 } }
      const timers = { kill: undefined as ReturnType<typeof setTimeout> | undefined }
      const cancel = () => {
        child.kill("SIGINT")
        void interrupt(task).catch(() => {})
        timers.kill ??= setTimeout(() => child.kill("SIGKILL"), 10_000)
      }
      const collect = (kind: "stdout" | "stderr", text: string) => {
        const size = Buffer.byteLength(JSON.stringify(text)) - 2
        if (output.sizes[kind] + size > outputLimit) {
          output.overflow = true
          cancel()
          return
        }
        output.sizes[kind] += size
        output[kind] += text
      }
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (text: string) => collect("stdout", text))
      child.stderr.on("data", (text: string) => collect("stderr", text))
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
      child.stdin.on("error", () => {})
      child.stdin.end(task.input.message)
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code) => resolve(code ?? 1))
      }).finally(() => {
        signal.removeEventListener("abort", cancel)
        if (timers.kill) clearTimeout(timers.kill)
      })
      if (exitCode !== 0 || signal.aborted || output.overflow) await interrupt(task).catch(() => {})
      try {
        await client.session.wait({ sessionID: task.sessionID }, request())
        const session = await client.session.get({ sessionID: task.sessionID }, request())
        const state =
          session.outcome === "succeeded" && exitCode === 0 && !output.overflow
            ? "completed"
            : session.outcome === "interrupted" && signal.aborted
              ? "cancelled"
              : session.outcome === "failed" || session.outcome === "interrupted" || output.overflow
                ? "failed"
                : "indeterminate"
        return {
          state,
          exitCode: state === "completed" ? 0 : state === "cancelled" ? 130 : exitCode || 1,
          stdout: output.stdout,
          stderr: output.stderr,
          ...(output.overflow
            ? { reason: "Client output exceeded its bounded capture limit" }
            : state === "indeterminate"
              ? { reason: "Child exited without a verified terminal Session outcome; task will not be replayed" }
              : {}),
        }
      } catch {
        return {
          state: "indeterminate",
          exitCode,
          stdout: output.stdout,
          stderr: output.stderr,
          reason: "Could not verify Session settlement; task will not be replayed",
        }
      }
    },
  }
}
