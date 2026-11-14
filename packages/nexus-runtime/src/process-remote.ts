import { APIError, Steps, type JsonObject } from "@cybros/agent"
import { Schema } from "effect"
import type { NexusApplication } from "./application"
import type { Processes } from "./processes"

/** Operator reads use the target runner's own table; process_log deliberately has no owner gate. */
export class ProcessTables {
  constructor(
    private readonly table: Processes,
    private readonly application: NexusApplication,
    private readonly signal: AbortSignal,
  ) {}

  async list(runner?: string, workspace = this.application.identity.workspace) {
    const processes: JsonObject[] = !runner || runner === this.application.identity.runner ? this.table.list() : []
    const unreachable: Array<{ runner: string; error: string }> = []
    const targets = runner
      ? runner === this.application.identity.runner
        ? []
        : [{ workspace, runner }]
      : await this.targets()
    await Promise.all(
      targets.map(async (target) => {
        try {
          const result = await this.read(target.workspace, target.runner, "list_processes", {})
          const rows = Schema.decodeUnknownSync(
            Schema.Struct({ processes: Schema.Array(Schema.Record(Schema.String, Schema.MutableJson)) }),
          )(result)
          processes.push(...rows.processes.map((row) => ({ ...row, runner: target.runner })))
        } catch (error) {
          unreachable.push({ runner: target.runner, error: error instanceof Error ? error.message : String(error) })
        }
      }),
    )
    return { processes, orphans: runner ? [] : this.table.takeOrphans(), unreachable }
  }

  async log(id: string, lines: number, runner?: string, workspace = this.application.identity.workspace) {
    if (!runner || runner === this.application.identity.runner) {
      const local = await this.table.log(id, lines)
      if (local || runner) return local
    }
    const targets = runner ? [{ workspace, runner }] : await this.targets()
    if (targets.length > 1) throw new Error(`no process ${id} here; name a runner's table with runner`)
    const target = targets[0]
    if (!target) return
    const result = Schema.decodeUnknownOption(
      Schema.Struct({
        process: Schema.Record(Schema.String, Schema.MutableJson),
        path: Schema.String,
        lines: Schema.mutable(Schema.Array(Schema.String)),
      }),
    )(await this.read(target.workspace, target.runner, "process_log", { id, lines }))
    if (result._tag === "None") return
    return { ...result.value, process: { ...result.value.process, runner: target.runner } }
  }

  private async targets() {
    const targets = new Map<string, { workspace: string; runner: string }>()
    await Promise.all(
      this.application.lifecycle.hostsSnapshot().map(async (host) => {
        const row = await this.application.client
          .workspace(host.workspace)
          .conversation(host.conversation)
          .fetch({ signal: this.signal })
        const runner = row.default_runner?.executor_public_id
        if (runner && runner !== this.application.identity.runner)
          targets.set(runner, { workspace: host.workspace, runner })
      }),
    )
    return [...targets.values()]
  }

  private async read(workspace: string, runner: string, tool: string, input: JsonObject) {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(15_000)])
    const executor = await this.application.client.executors.fetch(runner, { signal })
    const environment = executor.services.runner?.environment ?? {}
    const created = await this.application.client.workspace(workspace).runs.create(
      {
        approval_mode: "bypass",
        prompt_mechanism: "raw",
        default_runner_executor_public_id: runner,
        steps: [
          Steps.tool({
            key: "call_tool",
            name: tool,
            input,
            timeout_ms: 10_000,
            executor_context: { "opencode.environment": environment },
            route: { kind: "runner", runner_executor_public_id: runner },
          }),
        ],
      },
      { signal, idempotencyKey: crypto.randomUUID() },
    )
    const scope = this.application.client.workspace(workspace).run(created.run.public_id)
    const result = await (async () => {
      await scope.start({ signal }).catch((error: unknown) => {
        if (!(error instanceof APIError && error.status === 409 && error.code === "not_startable")) throw error
      })
      return scope.waitForToolResult({ signal, pollMs: 500, patienceMs: 15_000 })
    })().catch(async (error: unknown) => {
      await scope.stop(true, { signal: AbortSignal.timeout(5000) }).catch(() => {})
      throw error
    })
    if (result.task.status !== "completed") throw new Error(String(result.task.error?.key ?? result.task.status))
    if (result.task.result?.is_error) throw new Error("tool_error: " + (result.output ?? "the runner refused the read"))
    return result.structured_content
  }
}
