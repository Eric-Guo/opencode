# Experimental workspace-sharing CLI

This branch adds an explicit shared-filesystem connection mode. Ordinary run,
managed service, standalone, and explicit server connections remain the default
paths unless `--workspace-sharing` is selected. No production database migration,
credential copy, default configuration change, or automatic daemon installation
is included. The fake-only prototype is retained separately in `transport.ts`
and `script/workspace-sharing.ts` for transport regression tests.

## CLI usage

Start one foreground owner from the project directory. Use a private, canonical
absolute path for the sharing directory, separate from the OpenCode data folder:

```sh
opencode serve --workspace-sharing /absolute/private/spool
```

The service keeps its normal configuration and provider credentials in its own
process. Its HTTP endpoint is owner-local loopback with an ephemeral credential;
file clients never receive that credential or open the service database. Keep
this owner terminal/task alive. In other execs sharing the filesystem:

```sh
opencode run --workspace-sharing /absolute/private/spool --request-id task-one 'hello'
opencode run --workspace-sharing /absolute/private/spool --detach --request-id task-two 'another task'
opencode task status task-two --workspace-sharing /absolute/private/spool
opencode task result task-two --workspace-sharing /absolute/private/spool
opencode task cancel task-two --workspace-sharing /absolute/private/spool
opencode session list --workspace-sharing /absolute/private/spool --format json
```

Run prints its task and Session IDs on stderr. Normal mode waits for a terminal
result; `--detach` returns the admission record immediately. Output is delivered
after completion, not as a live stream. Exiting a file client does not cancel its
owned task. Cancellation is an explicit task operation and targets only its
bound, newly created Session. History uses the existing service's session API,
including sessions created outside the file queue.

This initial opt-in path supports text prompts, model/agent/title/thinking and
explicit `--auto`. It does not imply auto-approval. It rejects `--server` and
`--standalone` combinations and does not yet accept `--continue`, `--session`,
`--fork`, file attachments, or caller-supplied message IDs. Each task gets a fresh
Session to avoid ambiguous output and cancellation from shared-session writers.
Task directories must be inside the owner's canonical project directory.

## Ownership, retries and limits

- One owner is elected with atomic directory creation. PID absence, namespace
  differences, age and timeouts never grant takeover permission. Normal shutdown
  settles owned clients and closes the service before releasing the file owner.
  A crash leaves the marker for explicit investigation; there is no force-unlock
  or automatic recovery command.
- Formal tasks, receipts and captured output use private atomic JSON files.
  Only the existing service opens its SQLite database. The retained fake-only
  prototype has its own toy SQLite and is not imported by the production path.
- Task ID, Session ID, prompt/message ID and normalized request hash are durable
  before child dispatch. Mutating request IDs are immutable: retry exactly the
  same payload and ID. A repeated admission receipt may still say `queued`; use
  status/result for current state. A timeout is an unknown outcome, not authority
  to invent a new ID or rerun the task.
- One isolated CLI client subprocess per task reuses normal `run`, with an
  explicit owner-local server and bound IDs. No shell command or executable is
  accepted from the spool. Provider credentials and environment dumps are not
  transported.
- Concurrency is two. At most 128 task records and 4096 retained mutation requests
  are admitted in a sharing directory. Read-only polling removes its consumed
  envelopes, so a long wait does not accumulate permanent requests. Prompt text
  is capped at 16 KiB; stdout and stderr captures are separately bounded.
- Unknown Session settlement produces `indeterminate`, never blind replay, and
  blocks new dispatch/admission. Inspect the Session history before deciding
  what to do next. There is no automatic administrative reset for such a spool.
- The directory is a same-UID trust boundary: directories 0700 and files 0600,
  canonical paths, no final-component symlinks/FIFOs or unexpected hardlinks. It
  does not isolate malicious processes with the same UID and is not an auth
  protocol for third parties. Never use it to evade a denied permission/action.
- Atomic staging is fsynced before publication. An identical retry briefly waits
  for a publication staging hardlink to disappear. A publisher crash in that
  window leaves the request unreadable for investigation; it does not authorize
  cleanup or execution.
- Namespace metadata is diagnostic only; non-Linux platforms report unavailable
  namespace IDs rather than using PID guesses to decide ownership.

## Authentication and compatibility

SSO initialization is selected after actual CLI parsing. Only parsed file-client
run, task and session-list commands with an explicit sharing directory skip it.
Ordinary commands and sharing serve still initialize SSO before loading their
handlers. Prompt text, including text after `--`, cannot select the exemption.
Help/version and parser errors now avoid an unnecessary SSO initialization.

The sharing owner module is loaded lazily only for explicit sharing serve.
Normal service discovery, standalone leases, endpoint auth, and public Protocol
or generated-client surfaces are unchanged. `run --message-id` is an internal
identity hook used by the owner; ordinary run still creates a fresh message ID.

## Local checks

Use the repository-pinned Bun and installed workspace development dependencies.
From `packages/cli/test/workspace-sharing`, with HOME and XDG directories isolated:

```sh
bun test . ../run/noninteractive.test.ts ../server-connection.test.ts
bun typecheck
```

From `packages/cli`, run the full affected-package check:

```sh
bun typecheck
```

From the repository root, the canonical aggregate check remains `bun run check`.
The integration test uses a loopback fake OpenAI-compatible endpoint and a fresh
real service/database. It exercises the actual CLI, duplicate admission, result
query, service history, mixed-mode rejection and ordinary explicit-server run.
It uses no real account credentials or paid model.

The original transport checks additionally cover fake task concurrency, precise
cancellation, partial publication, request conflicts, private modes, symlinks,
SQLite sidecars, clean restart, and SIGKILL without automatic takeover.

## Historical prototype evidence

### Cross-exec prototype, 2026-10-05

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

At the initial prototype checkpoint, aggregate checks were blocked by missing
local development dependencies; only focused checks were available then. The
subsequent integration checkpoint also passed the affected CLI package typecheck.
Consult the commit validation notes for aggregate-check limitations.
