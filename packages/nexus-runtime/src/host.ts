import { Ripgrep } from "@opencode/core/ripgrep"
import { Snapshot } from "@opencode/core/snapshot"
import { Mcp } from "@opencode/core/mcp/index"
import { Integration } from "@opencode/core/integration"
import { Pty } from "@opencode/core/pty"
import { FileSystem } from "@opencode/core/filesystem"
import { Environment } from "@opencode/core/environment/index"
import { Shell } from "@opencode/core/shell"
import { ShellResult } from "@opencode/core/shell/result"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath, PositiveInt } from "@opencode/schema/schema"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { SessionMessage } from "@opencode/schema/session-message"
import { randomUUID } from "node:crypto"
import type { DesktopBrowser } from "./desktop-browser"

export function hostTools(locations: typeof LocationServiceMap.Service.Service, sessions: Session.Interface) {
  return {
    process: packageProcess,
    async desktopBrowser(id: string, signal: AbortSignal): Promise<DesktopBrowser> {
      const sessionID = Session.ID.make(id)

      await Effect.runPromise(sessions.get(sessionID), { signal })

      return (operation, input, signal) =>
        Effect.runPromise(
          sessions.get(sessionID).pipe(
            Effect.flatMap((session) =>
              Effect.gen(function* () {
                const agents = yield* Agent.Service
                const permission = yield* Permission.Service
                const registry = yield* Tool.Service
                const agent = yield* agents.resolve(session.agent)
                const name = "browser_" + operation
                const registered = yield* registry.list()
                const tool = registered.find((tool) => tool.id === name && tool.options?.permission === "browser")

                if (!tool)
                  return yield* new Tool.Error({
                    message:
                      "Enable the OpenCode Browser plugin and open the configured OpenCode session in the desktop app.",
                  })

                if (
                  !agent ||
                  !(yield* permission.allows({
                    sessionID,
                    agent: agent.id,
                    action: "browser",
                    resources: ["*"],
                    save: [],
                  }))
                )
                  return yield* new Tool.Error({
                    message:
                      "The configured OpenCode session needs an attached desktop Browser with browser permission.",
                  })

                // Expose only the requested browser action to execution hooks.
                const snapshot = yield* registry.snapshot(session.permissions, {
                  tools: {
                    direct: new Set([name]),
                    hidden: new Set(registered.filter((tool) => tool.id !== name).map((tool) => tool.id)),
                  },
                })
                const definitions = new Map(
                  snapshot.definitions.filter((tool) => tool.name === name).map((tool) => [name, tool]),
                )

                if (!definitions.has(name))
                  return yield* new Tool.Error({
                    message: "The requested browser action is unavailable in the OpenCode session.",
                  })

                return yield* snapshot.execute({
                  sessionID,
                  agent: agent.id,
                  messageID: SessionMessage.ID.create(),
                  call: { type: "tool-call", id: randomUUID(), name, input },
                  definitions,
                })
              }).pipe(Effect.provide(locations.get(session.location))),
            ),
          ),
          { signal },
        )
    },
    capture(directory: string, signal: AbortSignal) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          return yield* snapshot.capture()
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
    changes(directory: string, before: string, after: string, signal: AbortSignal) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          return yield* snapshot.diff({ from: Snapshot.ID.make(before), to: Snapshot.ID.make(after) })
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
    restoreTree(
      directory: string,
      before: string,
      after: string,
      current: string,
      signal: AbortSignal,
      pathsFrom?: string,
      pathsTo?: string,
    ) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          const from = Snapshot.ID.make(before)
          const to = Snapshot.ID.make(after)
          const paths = yield* snapshot.files({
            from: Snapshot.ID.make(pathsFrom ?? before),
            to: Snapshot.ID.make(pathsTo ?? after),
          })
          const later = yield* snapshot.files({ from: to, to: Snapshot.ID.make(current) })
          if (paths.some((path) => later.includes(path)))
            return yield* Effect.fail(new Error("Files have changed since this checkpoint."))
          return yield* snapshot.restore({ files: new Map(paths.map((path) => [path, from])) })
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
    mcp(directory: string) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const mcp = yield* Mcp.Service
          return mcp
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
      )
    },
    integration(directory: string) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const integration = yield* Integration.Service
          return integration
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
      )
    },
    pty(directory: string) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const pty = yield* Pty.Service
          return pty
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
      )
    },
    shell(
      directory: string,
      command: string,
      signal: AbortSignal,
      timeoutMs = 30000,
      progress?: (text: string) => Promise<void>,
    ) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const shell = yield* Shell.Service
          const result = yield* Effect.acquireUseRelease(
            shell.create({
              command,
              cwd: directory,
              timeout: timeoutMs,
              waited: true,
              ...(process.platform !== "win32" ? { shell: "/bin/bash" } : {}),
            }),
            (started) =>
              Effect.scoped(
                Effect.gen(function* () {
                  if (progress)
                    yield* Effect.forkChild(
                      Effect.gen(function* () {
                        let seen = 0
                        while (true) {
                          const current = yield* shell.output(started.id, { limit: 0 })
                          if (current.size > seen) {
                            const tail = yield* shell.output(started.id, {
                              cursor: Math.max(0, current.size - 4096),
                              limit: 4096,
                            })
                            seen = current.size
                            yield* Effect.tryPromise(() => progress(tail.output)).pipe(Effect.ignore)
                          }
                          yield* Effect.sleep("50 millis")
                        }
                      }).pipe(Effect.ignore),
                    )
                  yield* shell.wait(started.id)
                  return yield* shell.result(started)
                }),
              ),
            (started) => shell.stop(started.id, "killed").pipe(Effect.ignore),
          )
          const output = ShellResult.output(result)
          return {
            file: result.info.file,
            content: output.output,
            is_error: result.info.status !== "exited" || result.info.exit !== 0,
            structured_content: {
              truncated: output.truncated,
              exit: result.info.exit ?? null,
              status: result.info.status,
            },
          }
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
    grep(directory: string, pattern: string, include: string | undefined, signal: AbortSignal) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const ripgrep = yield* Ripgrep.Service
          const environment = yield* Environment.Service
          const matches = yield* ripgrep.grep({ environment, cwd: directory, pattern, include, limit: 100, signal })
          return matches
            .map((match) => match.entry.path + ":" + match.line + ": " + match.text.trimEnd())
            .join("\n")
            .slice(0, 65536)
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
    find(directory: string, query: string, signal: AbortSignal) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const files = yield* FileSystem.Service
          const rows = yield* files.find({ query, type: "file", limit: PositiveInt.make(100) })
          return rows.map((row) => row.path).join("\n")
        }).pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(directory) }))),
        { signal },
      )
    },
  }
}
export type HostTools = ReturnType<typeof hostTools>

export async function packageProcess(
  directory: string,
  command: string,
  args: string[],
  signal: AbortSignal,
  timeout = 60000,
) {
  signal.throwIfAborted()
  if (process.platform !== "win32") {
    const { OwnedProcess } = await import("./owned-process")
    // Keep the group leader alive until cleanup, even when a successful test leaves descendants.
    const child = new OwnedProcess(
      [command, ...args].map((word) => "'" + word.replaceAll("'", "'\\''") + "'").join(" "),
      directory,
    )
    child.child.stdin?.end()
    const capture = { output: Buffer.alloc(0), bytes: 0, timedOut: false }
    const reading = (async () => {
      for await (const chunk of child.output) {
        capture.bytes += chunk.length
        capture.output = Buffer.concat([capture.output, Buffer.from(chunk)]).subarray(-65536)
      }
    })()
    void reading.catch(() => {})
    const interrupted = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      capture.timedOut = true
      interrupted.resolve()
    }, timeout)
    const abort = () => interrupted.reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    try {
      await Promise.race([
        (async () => {
          await child.started
          if (child.leaderExited) return
          await new Promise<void>((resolve) => {
            child.once("change", resolve)
            void child.exited.then(resolve)
          })
        })(),
        interrupted.promise,
      ])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      await child.close()
      await reading
    }
    return {
      exitCode: child.status ?? -1,
      timedOut: capture.timedOut,
      output: capture.output,
      stdout: capture.output,
      outputTruncated: capture.bytes > 65536,
    }
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AppProcess.Service
      const handle = yield* service.spawn(
        ChildProcess.make(command, args, { cwd: directory, stdin: "ignore", extendEnv: true }),
      )
      const capture = { output: Buffer.alloc(0), bytes: 0 }
      const completed = yield* Effect.all(
        [
          Stream.runForEach(handle.all, (chunk) =>
            Effect.sync(() => {
              capture.bytes += chunk.length
              capture.output = Buffer.concat([capture.output, chunk]).subarray(-65536)
            }),
          ),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.succeed(null),
        }),
      )
      return {
        exitCode: completed?.[1] ?? -1,
        timedOut: completed === null,
        output: capture.output,
        stdout: capture.output,
        outputTruncated: capture.bytes > 65536,
      }
    }).pipe(Effect.scoped, Effect.provide(LayerNode.compile(AppProcess.node))),
    { signal },
  )
}
