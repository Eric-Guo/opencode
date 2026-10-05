# Workspace sharing: fake-only CLI prototype

This is an experimental file task transport, based on commit
`d84cecc5bdad08a16600c8cdf113b68c095cec79`. It is not wired into the production
`opencode` command, does not use provider credentials, and does not execute real
models, tools, shell commands, or existing OpenCode sessions.

## What exists

- `src/services/workspace-sharing/transport.ts`: one file-queue owner, one SQLite
  database, immutable request IDs, task query/result/cancel and simple session
  labels. A task only waits for a bounded delay and returns `fake:<text>`.
- `script/workspace-sharing.ts`: explicit experimental `--workspace-sharing`
  entrypoint. Conflicting `--server` or `--standalone` options are rejected.
- `test/workspace-sharing/transport.test.ts`: transport, lifecycle, bounds and
  filesystem boundary regression tests.

Only the worker opens SQLite. Clients publish requests and read replies; they
never open the database, interpret foreign PIDs, or discover loopback endpoints.
Worker ownership is an atomic directory creation, without PID/TTL takeover.
Normal shutdown closes SQLite before releasing its own marker. A crash leaves
its marker, and subsequent starts refuse to take over. There is no crash-recovery
or force-unlock command.

Requests are staged, fsynced and hard-linked into place without overwriting an
existing request. Replies are staged, fsynced and atomically renamed. Duplicate
publication briefly has two links; an identical retry waits briefly for the
publisher to remove its staging link. A publisher crash in this interval leaves
an unreadable request for inspection, not permission to execute or recover it.
Malformed files and partially written staging files are not executed.

The owner stores admission and each request's receipt in one SQLite transaction.
Repeating a request ID returns its original receipt; conflicting reuse fails.
In particular, a repeated submit receipt can still say `queued` after completion.
Use a new query/result request ID to get current task state. A timeout means
service unavailable or outcome unknown: retry the same mutation ID, never create
a new mutation to guess what happened. This is not an exactly-once guarantee for
future model/tool execution.

## Scope and bounds

- Linux + Bun 1.4.2, ordinary local shared filesystem semantics.
- Same-user private directory trust boundary: directories 0700, files 0600,
  owned by the current UID. Root paths must be absolute, normalized and contain
  no symlinks. Reads reject final-component symlinks, FIFOs, unexpected hardlinks,
  oversized files and broad permissions; SQLite sidecar symlinks are rejected.
- This is not protection from an adversarial process with the same UID. Such a
  process can forge or replace files. There is no separate identity or auth
  protocol. Never put untrusted third-party input into this channel as authority
  to execute a real task, and never use it to evade a permission/reviewer denial.
- Concurrency is 1 or 2, default 2. There are at most 128 admitted tasks, 4096
  request files through the client, 4096 UTF-16 text units per fake task, 64 KiB
  per wire envelope, and 60 seconds per task. No automatic garbage collection.
- Worker lifetime is explicit and bounded by the experimental CLI (at most ten
  minutes). No automatic daemon start, reconnect, takeover or queued-work replay.
- Cancellation targets only a task ID in the owner's task table. It does not
  signal a PID supplied by a client. Client exit does not cancel worker tasks.
- Session labels and this toy task database are not the production OpenCode
  session/event schema. Actual `run`, `--session`, `--continue`, streaming output,
  tool permissions, provider calls and real history are not integrated.

## Run focused checks

From `packages/cli/test/workspace-sharing`:

```sh
bun test transport.test.ts
bun typecheck
```

The local bunfig intentionally avoids the CLI package's unrelated TUI preload.
Focused typechecking needs the existing CLI development dependencies. Runtime and
transport tests themselves use Bun/Node built-ins and install no new dependency.

For manual experiments, use a fresh, private directory and isolated HOME/XDG.
Keep the owner in a foreground terminal:

```sh
bun ../../script/workspace-sharing.ts --workspace-sharing /absolute/private/spool serve --lifetime-ms 60000
```

In another exec/terminal using the same filesystem:

```sh
bun ../../script/workspace-sharing.ts --workspace-sharing /absolute/private/spool submit --id example-one --text hello --duration-ms 1000
bun ../../script/workspace-sharing.ts --workspace-sharing /absolute/private/spool result --task example-one
bun ../../script/workspace-sharing.ts --workspace-sharing /absolute/private/spool sessions
```

These examples assume the same test-directory working directory as the focused
checks. Do not point the prototype at a real OpenCode data directory.

## Verified experiments, 2026-10-05

The user started a fresh foreground worker with the one-line test launcher.
Its PID/net namespaces were `4026532200 / 4026531833`; independent client execs
were `4026532331 / 4026532332` and `4026532328 / 4026532329`.

Two tasks were observed running and a third queued. After the first submitting
exec exited, a different exec still observed its task running. That exec cancelled
only task B. Tasks A and C completed with the expected fake results; each had one
start. History contained all three labels, the worker reported maxActive=2, and
there was one `tasks.sqlite` in that workspace. The user then stopped the worker;
its owner marker was released and a read-only SQLite integrity check returned
`ok`, with all three task records retained.

A separate cross-exec regression after the large-payload/idempotency fixes also
passed submit/query/cancel/result/history with distinct namespaces. All test-owned
foreground workers were observed to stop normally. A later startup-only SQLite
sidecar check has its own focused regression.

A detached launch experiment did NOT establish reliable daemon survival:
a ready worker was started with detached stdio, the launching exec returned exit
0, and subsequent execs got no response. Its owner marker remained. No takeover
or cleanup of that marker was attempted. Thus file transport crosses executor
namespaces, but this environment still needs a genuinely persistent owner
terminal/task. `nohup` or `setsid` is not a demonstrated solution to that lifecycle
requirement.

Full repository `bun run check` is blocked because oxlint is not installed in this
checkout's reusable dependency set. The CLI-wide typecheck is also blocked by
missing workspace/development dependency links and declarations. Focused
prototype typechecking and tests passed; these are not a full repository pass.

## Smallest next production step

1. Add an explicit run-handler branch before `ServerConnection.resolve` and
   reject incompatible connection options. Do not represent a directory as an
   HTTP endpoint or weaken existing foreign-domain ownership guards.
2. Keep one real service/database in the persistent owner's namespace. A narrow
   owner-side adapter can run separate existing CLI client subprocesses against
   that service's owner-local explicit server URL. Capture each client's output
   separately; send structured argv and prompt stdin, no arbitrary commands,
   inherited environment dump or credentials in the spool.
3. Start with distinct new Sessions per task and concurrency two. Tie durable
   task ID, Session ID and prompt/message ID before real admission. On ambiguous
   failure, mark indeterminate instead of retrying with a new prompt ID.
4. Map cancellation to the owned task's Session and preserve existing permission
   rejections. Sharing mode must not imply `--auto`. Existing `--session` and
   `--continue` need deliberate same-Session admission/isolation rules.
5. Expose history through the single service's real session APIs. Add the small
   bounded result/stream mechanism required by run; do not proxy the whole HTTP
   API or add a general remote execution platform.

Direct concurrent reuse of `runNonInteractive` is currently unsafe: it changes
process cwd, and `runNonInteractivePrompt` uses global stdout/exitCode/SIGINT. An
in-process adapter first needs injected output, cancellation and result reporting.
`resolveSessionTarget` and the existing subscription-before-admission/wait logic
are reusable, but current run code creates a fresh message ID per invocation, so
blind replay can duplicate real work.

No production CLI registration, public Protocol/HttpApi change, generated client
change, database migration, production-runtime modification, deployment,
wrapper/auth modification or real model call is part of this prototype.
