# Nexus runtime

OpenCode's managed service hosts the Nexus Agent and Local Runner. The runtime
uses the packaged TypeScript Nexus SDK and OpenCode's host services. Enablement
is controlled by `experimental.nexus_runtime`.

## Application settings and one-shot runs

`opencode nexus settings` reads the installation's application policy. Update individual
fields with `opencode nexus settings --json '{"subagent_default":false}'`. Settings
include `default_model`, `fallback_models`, `kernel_tools`, `subagent_default`,
`adaptations`, `adaptations_dir`, and `conversation_title_model`. They are stored
privately in `application-settings.json`; pairing and Human credentials remain separate.
The approval default is `ask`.

Adaptations use the bundled reference pack, overlaid by `*.yml` rows in the installation's
`adaptations` directory or `adaptations_dir`. `adaptations` accepts `auto`, `off`, or a
row ID. The installation's default model selects declaration spellings; each input's
selected model supplies its hints. Invalid rows and moved description anchors refuse
publication. Reference data is shipped in this package, with no runtime dependency on Rho.

`nexus.codemode` controls Code Mode availability and its `default` (`on` or `off`).
New Main conversations capture Code Mode and Subagent defaults; forks and Sides inherit
those choices. Existing accepted work keeps its captured declarations.

New untitled Main and Bot conversations get one background title attempt after their
first accepted reply input. `conversation_title_model` is `follow_current` by default,
a model reference, or `null` to disable. Manual titles win. Temporary title Sides are
removed after completion, failure, timeout, or shutdown.
Title generation uses the first 4,000 Unicode characters of the input and retains
at most 255 Unicode characters of the first title line, preserving complete emoji.

```sh
opencode nexus run "Inspect this project" --output-format json
opencode nexus run "Fix the failing test" --until "bun test" --attempts 3 --timeout 600
opencode nexus run "Describe the image" --attach picture.png -p
opencode nexus pair --url https://nexus.example.com --model provider/model --api-key-stdin
```

API-key import reads one JSON object containing `access_token` and
`executor_access_token` from stdin. Both must identify the same Agent application.
Candidate validation preserves the current connection on failure. Imported credentials
restore after restart and disconnect revokes both tokens.

One-shot runs use the same admission, model policy, tools, captured environment and
Until checks as other surfaces. They deny unattended approvals and stop their owned
work on a question, unresolved hold, timeout, or interrupt. Exit codes are `0` for
completion, `1` for failure/refusal/cancellation, `2` when a person or timeout prevents
completion, and `130` for interruption. `--output-format` accepts `text`, `json`, or
`stream-json`; `-p` prints only the final answer. HTTP clients use the experimental
`POST /api/experimental/nexus/run` SSE endpoint. HTTP recovery remains authoritative
when realtime transcript frames are unavailable.

## Scheduled jobs and web fetch

Use `opencode nexus jobs CONVERSATION` to list a conversation's jobs. The terminal and
Telegram accept the same timing expressions. Absolute times include their UTC offset.
The `list` and `history` commands print the cursor for the next page when one exists.

```sh
opencode nexus jobs CONVERSATION create once in 20m Review the build
opencode nexus jobs CONVERSATION create daily 09:00 Australia/Perth Summarize the overnight runs
opencode nexus jobs CONVERSATION show JOB
opencode nexus jobs CONVERSATION edit JOB every 2h
opencode nexus jobs CONVERSATION history JOB --output-format json
```

Use `pause`, `resume`, `run` or `cancel` with a job ID. A create accepts `--model`
and each command accepts `--workspace`. Edits read the current lock version before
submitting the changed fields. `opencode nexus schedules` lists jobs across the workspace.

Use `opencode nexus persona` or `opencode nexus persona show` to read the signed-in
Human's instructions for future personal turns. `persona set FILE` accepts up to
64 KiB of UTF-8 text. Use `persona set -` for standard input and `persona reset`
to clear the document. Each accepts `--output-format json`. An absent document
reads as JSON `null`.

`opencode nexus web-fetch URL [--raw]` uses the local Web reader configuration and
works while disconnected. It writes the whole rendering or the original binary to
stdout and the HTTP status line to stderr. A refusal writes its explanation to stderr
and exits 1. The same network and size limits apply as for the runner tool.

## Standalone inference requests

The paired Agent can submit a standalone workload in its selected workspace.
Supply a stable key for each submission and reuse it when retrying the same
request. `workspace` can select another workspace available to the Agent.

```sh
opencode nexus manage --json '{"action":"inference.create","key":"example-1","model":"provider/model","input":"Say hello","live":false}'
opencode nexus manage --json '{"action":"inference.list"}'
opencode nexus manage --json '{"action":"inference.subscribe","request":"REQUEST_ID"}'
opencode nexus manage --json '{"action":"inference.unsubscribe","request":"REQUEST_ID"}'
```

Creation returns the accepted request ID in `public_id`. The list shows
requests followed by this service in the specified workspace. Each row
includes preview text, event sequence, status and the full result when
`complete` becomes true. Unsubscribing switches to lifecycle events.
It leaves the request running and the final result available. The follower
list lasts for the connection. After reconnecting, replay the original
submission with its key or read the saved ID through the Nexus member API.

## Extension configuration

Inspect saved configuration, active tools and readiness:

```sh
opencode nexus extensions
```

Save configuration with explicit field operations. Activation happens
asynchronously; inspect the extension list for the resulting state. An active
restart-only integration keeps its current instance until the service restarts.
Secret fields are write-only in API and CLI projections.

```sh
opencode nexus configure --json '{"id":"nexus.browser","operations":[{"op":"set","path":["executable"],"value":"/absolute/path/to/chromium"}],"enabled":true}'
opencode nexus configure --json '{"id":"nexus.mcp","operations":[{"op":"set","path":["servers"],"value":["docs"]}],"enabled":true}'
```

The HTTP equivalents are `GET /api/experimental/nexus/extensions` and
`PATCH /api/experimental/nexus/extensions/configuration`. Installation settings
live in the runtime's private `configuration.json`, separately from pairing and
Human login credentials. Existing adapter environment variables provide initial
defaults; saved settings take precedence.

Built-in execution settings use the same extension configuration:

- `nexus.coding` controls filesystem and shell tools. `bash_timeout_seconds` defaults
  to 120 and accepts integers from 1 through 540; an explicit call timeout wins.
  Until acceptance checks use this setting when authored or recovered. Bash retains
  its native hard timeout and does not renew its claim.
- `nexus.checkpoints` controls automatic captures and checkpoint operations.
  `retention_days`, `max_file_bytes`, `max_tree_bytes`, and `capture_timeout_seconds`
  default to 7, 2097152, 268435456, and 30. Disablement preserves saved history.
- `nexus.lifecycle-hooks` publishes optional `turn_start`, `pre_compact`, `post_compact`,
  and `stop` groups to Nexus. Each names an Agent-service tool and `timeout_ms`
  (1–300000); Stop also supplies `max_continuations` (0–20). Configure each group
  as a complete JSON object. An empty configuration installs no hooks. Preset hook
  overrides continue to apply.

These extensions default to enabled. Changes affect subsequent calls and declarations;
active handlers retain their captured settings and already admitted work retains its
recorded declaration. Code Mode and project skills have their own enablement controls.

Custom TypeScript/JavaScript modules selected through `OPENCODE_NEXUS_EXTENSIONS`
can export `register(api)` and supply a sibling JSON descriptor. The descriptor
contains `id`, `name`, `description`, `default_enabled`, `configuration_version`,
`configuration_schema` and `defaults`, with optional `requires` and `restart_only`.
Disabled modules are described without importing their executable code. Legacy
default-export factories continue to load; their generated IDs are shown in the
extension list.

Registration stages tools, management commands and cleanup handlers before publication. A failed
registration releases its resources and leaves working extensions available.
Running handlers retain their original extension instance until they exit.
`RunnerTool.resource` declares shared local concurrency; `internalTimeout` opts
out of claim renewal for a tool with its own hard deadline. Set
`environmentRequired: false` for a tool that does not access local directories;
it can execute without captured placement. Tools and management commands enforce
their JSON Schemas, including patterns, conditional requirements and unknown-field
rules, without coercing or discarding arguments. MCP discovery and native Code
Mode use the same validator.

Custom and managed modules execute in replaceable workers. A blocked synchronous
handler cannot block the service's claim clocks. Cancellation first reaches the
handler, then terminates an unresponsive worker after its grace period, cancels
its sibling calls and releases their resource permits. Subsequent calls load one
replacement with the same registered contributions. SDK calls, streams, callbacks
and abort signals cross the worker boundary; unreachable remote references are
released rather than retained for the lifetime of the service.

`api.registerCommand(name, handler)` exposes an installation-owned management
handler. Commands and tools share registration validation and retirement leases;
a failed candidate publishes neither. Reads and calls use the loaded instance
immediately.

### Extension execution hooks and owned activities

Extensions can gate or rewrite executor calls and observe their results:

```ts
export function register(api) {
  api.on("experimental.tool.call", ({ tool, input, context }) => {
    if (tool.name === "write" && input.path === "protected.txt") return { veto: "This file is protected." }
  })
  api.on("experimental.tool.result", ({ result }) => result)
  api.onStartup(async () => {
    /* initialize resources before publication */
  })
  api.background("poller", async (signal) => {
    /* run until the signal is aborted */
  })
}
```

A call hook returns `{ rewrite: arguments }`, `{ veto: reason }`, or no decision.
Hooks run in registration order. Rewritten arguments are validated and checked
against the existing refusal policy before execution and checkpoint capture. Vetoes
and call-hook exceptions become completed tool errors. Result-hook exceptions leave
the preceding result available to later observers. `onToolResult` remains supported.
The execution retains its original hooks and resources through actual completion,
including cancellation and extension replacement. Worker hooks receive the same task
signal, placement and context as the tool.

`registerCommand(name, handler, { description, input_schema })` optionally publishes
usage metadata and validates command input. Commands use `nexus manage` and the
existing authenticated `extension.call` API. `registerAgent({ name, description,
system_prompt, configuration })` publishes an extension-owned named identity;
omitting `configuration.default_model` inherits the request model. These identities
are separate from editable Bots and imported Presets. The `bot-` prefix is reserved.
`registerConversationServers(handler)` installs the single active editor-MCP factory
using the existing session attachment contract. Its returned sets close with the
owning registration. Initialization failure publishes none of the staged contributions;
autonomous activities start after publication and stop when their owner retires.
`restartOnly()` marks an active registration as requiring a service restart for
configuration changes or disablement.

## ACP editor surface

`opencode nexus acp` exposes Nexus conversations over ACP. `--mode ask|bypass|rules`,
`--model provider/model` and `--runner EXECUTOR_ID` seed new sessions. Saved model
and approval choices win on load/resume. The surface advertises built-in commands
and discovered skills, captures editor roots, and submits through shared runtime
admission with the signed-in Human credential. Closing the client releases its
editor filesystem and MCP attachments while accepted work remains owned by Nexus.

New prompts can carry a PDF as an embedded ACP resource with MIME type
`application/pdf` and a base64 `blob` of up to 16 MiB decoded. ACP returns
invalid params when a surface command or held answer includes a PDF.

ACP history preserves message roles, omits compaction summaries and renders a
Side's parent reference as one labelled context chunk. Load and resume can recover
held work after restart even when no active-turn pointer remains; inherited history
never becomes a retry or abandon target.

Editor filesystem requests validate their responses and have a 30-second read or
60-second write deadline. An unavailable editor retires its matching live binding;
reads fall back to disk with a notice, including when the disk read also fails.
Writes and edits report an error without falling back after an uncertain response.
A missing buffer permits disk access for that call, except after an edit has already
read the buffer and attempted its write. Editor cancellation interrupts the task.

Persistent approvals use the shared runtime grant owner through
`application.approve` on the experimental management API. Native `web_fetch`
approvals retain the literal site until the service restarts; command, path and
remote MCP callable scopes use the same rules as development controls. The task is
approved with the signed-in Human credential. If retaining its grant fails, the
editor reports that separately from the successful one-time approval. Cancelling a
permission card leaves the task undecided; cancelling the session stops its work.

## ACP delegation

Configure coding agents through `nexus.acp-client`. Each row needs a launch command
and your description of when the model should use it:

```sh
opencode nexus configure --json '{"id":"nexus.acp-client","enabled":true,"operations":[{"op":"set","path":["agents"],"value":{"coding-agent":{"command":"/absolute/path/to/agent","args":["--acp"],"description":"Delegate coding tasks in this project","env":{"API_KEY":"${AGENT_API_KEY}"},"permissions":"allow","timeout_ms":600000}}}]}'
opencode nexus manage --json '{"action":"acp.list"}'
opencode nexus manage --json '{"action":"acp.probe","agent":"coding-agent","workdir":"/absolute/project"}'
```

Environment references expand once from the service's environment. Expanded
values and credential-shaped literal values are redacted from model replies,
management projections and transcript captures. Children inherit a small process
environment plus the row's explicit `env`. Invalid rows report diagnostics while
healthy rows remain available. Legacy command-array rows still work, with their
existing per-request permission relay. Changes to active ACP settings take effect
after a service restart. Agent names use lowercase letters, digits and single
hyphens, up to 32 characters.

`delegate_agent` owns one resident child per workspace, conversation and agent.
Each call opens a new session unless it supplies a returned `session` ID. A
continuation keeps its original working directory, even if the runner's directory
changes. Other conversations cannot reuse that ID. `auth_method` selects an
agent-managed login method; a sole agent-managed method can be selected
automatically. Terminal login methods require the agent's own login outside this
client. `model` selects a value through an advertised model configuration option.

Pass `attachments` to `delegate_agent` to forward selected PDFs in order.
Use Nexus attachment URIs or upload UUIDs readable by the current executor
claim. The child must advertise ACP `embeddedContext`. Each PDF can be up to
16 MiB. The delegated prompt carries the original bytes, and the transcript
records each PDF's URI, MIME type and size.

The client advertises no editor filesystem, terminal or session-MCP facilities.
Elicitation is declined and surfaced in the result for a subsequent prompt.

Object rows default to `permissions: "allow"`; `"reject"` declines all requests.
Neither policy grants standing permission. Both ACP permissions and native runner
claims apply Rho's nine literal refusal rules and protected runtime paths. This
floor does not confine arbitrary programs: delegated agents run as the service's
user with their own tools.

Ordinary cancellation sends `session/cancel` and keeps the child. A new prompt
waits until the previous canceled request has answered; late output stays in the
transcript and cannot enter the next result. A hard timeout terminates the child
process group and invalidates its sessions. Captures are private JSONL files,
bounded to 16 MiB per child, and a successful call publishes a transcript snapshot
when an upload context is available.

Management uses `acp.sessions`, `acp.logs` and `acp.kill` (the latter two take a
local `session` ID). Killing any session retires all sessions in that child.
`acp.release` takes `workspace` and `conversation` and releases that conversation's
children. Service shutdown releases all children. Host-ended release and live progress forwarding use the shared lifecycle. Archiving a conversation preserves its accepted work; deletion or loss of the host releases its children.

## Application policy

The runtime now owns a surface-independent `NexusApplication`. Presets and Bot
settings live in the paired Agent's Nexus Store, so they survive service restarts.
First use seeds Personal and Peer plus the published worker, planner, explorer
and reviewer roles. Creating or duplicating a Preset does not publish a role.

Use the existing management command or `POST /api/experimental/nexus/manage`:

```sh
opencode nexus manage --json '{"action":"preset.list"}'
opencode nexus manage --json '{"action":"preset.create","value":{"name":"Writer","description":"Draft reports","configuration":{"system_prompt":"Draft clear reports.","fallback_models":[]}}}'
opencode nexus manage --json '{"action":"bot.create","name":"assistant","description":"Personal assistant","settings":{"home_workspace_public_id":"WORKSPACE_ID"}}'
opencode nexus manage --json '{"action":"bot.list"}'
opencode nexus manage --json '{"action":"application.memory","conversation":"CONVERSATION_ID","command":"grep project decisions"}'
```

`application.memory` shares the Telegram commands `ls [PATH]`, `read PATH`,
`write PATH TEXT`, `edit JSON`, `grep PATTERN` and `delete PATH`. Use `workspace`
for a conversation outside the paired workspace and `speaker` to select an ingress
Speaker. The CLI prints text by default. Set `format` to `json` for the underlying
records. Each mutation carries the collection, document and version preconditions.

Preset commands cover read, replacement, duplication, removal, portable JSON and Markdown import/export, role publication and atomic application defaults. Bot commands cover settings, identity,
duplication, history, current/new/resume/fork, atomic Home-workspace switches and submission. Reading a Bot never
creates a conversation. New Bot conversations require a Home Workspace; switching
archives the previous root without canceling its accepted work. External Bots have no ordinary local runner or Code Mode access and require a requester identity on submission. Their selected MCP tools, peer identities, child roles and scoped memory permissions are narrowed independently. Changing an External Bot to Personal requires duplication.

`application.open`, `application.submit` and `application.result` expose Main
Agent admission and recovery. Supply a stable operation `key` for mutations.
Submission saves the original model, fallbacks, agent configuration, tools and
executor contexts before posting the input. Retrying that key after an uncertain
response uses the saved declaration; a changed request with the same key fails.
Bot input retries retain their original conversation after a switch.
`application.prepare` takes the same fields as `application.submit` and captures
policy plus `turn.author` output without posting an input. Submit the same key and
fields to reuse that capture, including after a restart. Human surfaces pass their
credential through `x-nexus-origin` and `x-nexus-member-token`; admission preserves
the Human author and rejects reuse by another principal. The UI bridge keeps only
a request-bound preparation ticket; the runtime owns the captured declaration.
The managed runtime stores preparations locally, scoped to the paired Nexus
origin and agent. On first use it copies legacy admission records from the Nexus
profile before releasing those profile slots. Keep the runtime storage when moving
an installation that has outstanding retries.
`application.skills` returns the available skill names and descriptions for ACP. The exported
application follower recovers the requested input and its fallback chain through
SDK HTTP replay, independently of realtime delivery. Persona read/write/reset
uses the separately stored Human platform credential established by `nexus login`.

## Browser backends

The default Chromium backend checks the configured executable before exposing
any tools. One private Chromium process shares cookies across loops. Each run
owns a tab; calls on that tab serialize, while other runs can browse concurrently.
`browser_snapshot` and page actions return an accessibility tree with refs such
as `e2_17`. Click and type accept those refs, and stale refs fail explicitly.
Screenshots publish PNG attachments; `full_page` includes the scrollable page.

```sh
opencode nexus configure --json '{"id":"nexus.browser","operations":[{"op":"set","path":["executable"],"value":"/absolute/path/to/chromium"},{"op":"set","path":["idle_seconds"],"value":600}],"enabled":true}'
```

Idle cleanup retires unused tabs and their popups without interrupting active
calls. A wholly idle browser releases its context. The first result on a new or
recreated tab warns that earlier refs are invalid. Cancellation retires its own
tab; another loop keeps its tab and cookies. The native implementation uses
Chromium's private debugging pipe and needs no Ruby or separate Node driver.

To use the OpenCode desktop Browser, create a dedicated OpenCode session on
the same managed service. In Nexus
**Plugins → Browser → Settings**, set `backend` to `desktop` and
`desktop_session` to the OpenCode session ID, then enable Browser. The CLI can
save the same settings:

```sh
opencode nexus configure --json '{"id":"nexus.browser","operations":[{"op":"set","path":["backend"],"value":"desktop"},{"op":"set","path":["desktop_session"],"value":"<opencode-session-id>"}],"enabled":true}'
```

If Browser reports **Restart required** after saving, restart the managed
service and reopen the Nexus tab. Send a new Nexus message after the
tools appear. In SigmaAgents, keep the Nexus tab open to attach its Browser
pane. An OpenCode session's Review pane can also host the attachment. Each
Nexus conversation opens its own tab in the attached pane, and the tabs
share the attachment's browser profile. Nexus closes its tabs on idle or
shutdown while the desktop is connected. For screenshots, keep the Browser
pane visible.

## Runner dispatch and recovery

Realtime `work_available` notifications claim the named task directly. Only the
HTTP claim supplies executable arguments; duplicate nudges join the same local
ownership entry. Questions and human-held approvals remain outside the runner.
The recovery sweep reads one page of at most 50 rows, advances its cursor, and
wraps after the last page. Missing every notification still recovers through HTTP.

Startup admission reserves a slot and any declared resource before claiming.
The default is two to eight startup slots, according to available CPU parallelism.
A handler reaching its first asynchronous wait releases its startup slot, allowing
Code Mode's child tools to start. A resource permit lasts until the real handler
exits, including a canceled handler that has not returned. Listener replacement
retains those resource permits. Cancellation addresses both the run ID and task
key, so the same task key in another run is unaffected.

The claim boundary checks placement, service role, resource admission and the
tool's input schema before invocation. Invalid arguments return a tool error;
a returned tool error completes normally, while a handler that throws fails the
task. Execution timeouts request cancellation early enough to leave submission
headroom, and retain the granted claim deadline for settlement. No deadline means
no invented execution timeout. Renewal uses the tool's announced timeout and
stops when execution ends.

Results are saved before commit. A lost response is reconciled through the claim,
and transient delivery failures retry within its deadline, honoring `Retry-After`.
An undelivered result remains in the journal for a later sweep or restart; the
handler is never replayed. NUL bytes are escaped before storage, and serialized
results reserve space below Nexus's 1 MiB bound. Model text takes priority over
oversized structured data. Executor authorization loss stops further claims and
requires the operator to reconnect.

`opencode nexus status` and `GET /api/experimental/nexus/status` include an
`executor` snapshot: `running`, `in_flight`, `starting`, `startup_limit`, `claimed`,
`swept`, `nudged`, `canceled` and the latest unresolved `issue` type/code. SDK
failures use stable class labels rather than their inherited `Error` name. A clean
idle recovery sweep clears an older issue; new failures and failures retained by
active handlers or unreconciled journal records remain visible. In-flight ownership
includes canceled handlers that still retain a resource. Comparing `nudged` with
`swept` distinguishes a working realtime path from recovery polling alone.

## Managed processes

`start_process`, `list_processes`, `read_process` and `stop_process` manage
conversation-owned servers and watchers. Processes keep their birth directory,
survive individual tool calls, expose bounded rotating logs and report exits in
the next tool result. Host deletion and runtime shutdown release their process
groups. The `processes` and `logs` commands also query other selected runners.

## Managed extension packages

The installation owns immutable copies of local extension source. A package has
`nexus-extension.json` and `extension.ts` (or a relative `entry` in its manifest).
Installation and listing do not import executable code. A full SHA-256 digest
selects a version; activation stages registration before publishing and saving the
selection. A failed candidate preserves the previous instance. Rollback restores
that version's configuration and requires a compatible `state_schema`.

```sh
opencode nexus manage --json '{"action":"extension.call","name":"packages","input":{"action":"package.install","path":"/absolute/path/to/extension"}}'
opencode nexus manage --json '{"action":"extension.call","name":"packages","input":{"action":"package.list"}}'
opencode nexus manage --json '{"action":"extension.call","name":"packages","input":{"action":"package.check","name":"example","version":"FULL_SHA256"}}'
```

`package.activate`, `package.disable` and `package.rollback` use the same owner.
Checks execute `test/**/*.{test,spec}.{ts,js}` with installed Bun, a 60-second
process deadline and bounded output. The Agent's `manage_extension` tool exposes
package operations. `list_extensions` returns `extensions` with activation
status and registered tools for the runtime's catalog, including built-ins like
Browser, and `packages` with the installed personal versions and selections.
Use `tool_search` to check tool availability in the current conversation.
Credentials in configuration and schema annotations are redacted. Invalid saved
fields retain valid siblings and fall back independently; configuration
diagnostics identify paths without including their values.

Extensions can register documents, environment descriptions and lifecycle hooks.
`turn.author` is ordered and fails closed before durable admission. Its authored
body and notes are saved once; retries do not rerun authors. `turn.follow` gates
retain their extension instance until cancellation. Settlement observers are
independent of memory review. `host.ended` releases conversation-owned resources;
`conversation.binding` is a read-only ingress projection.

## Captured instructions and Code Mode

Repository `AGENTS.md` and `CLAUDE.md` files are read from the working directory
through its root, followed by the installation's `AGENTS.md`. The nearest files
receive the 32 KiB content budget first; sections render from general to specific.
The resulting instructions and editor-buffer guidance are captured at admission.
Compaction, image-generation and scheduling enablement have separate extension
settings; compaction supplies the summary policy and instructions to Nexus.

Conversation environment records preserve independent roots and extra directories
for each runner. Editor filesystem and MCP attachments are live session resources;
they are not saved as durable credentials. Children and Side conversations inherit
the parent's attachment anchor. Editor MCP requires the `nexus.mcp` extension;
disabling it closes its editor attachments. Runner discovery, selection and changes to the
installation's default directory affect future work, while admitted tasks and
managed processes keep their captured placement.

Code Mode uses `@opencode/codemode` with binding `urn:opencode:nexus:codemode:1`.
It uses OpenCode's supported JavaScript subset, copied bindings, native Promise
scheduling, diagnostics and final-expression results. Classes and full JavaScript
compatibility are not promised. The old Rho JavaScript binding is refused before
effects; create new work with the current declaration after upgrading.

Only frozen declarations are callable. Every child tool runs through Nexus's
claim operations and approval policy; there is no direct filesystem or network
capability. `text(string)` and `console.log` select visible output, `value(json)`
retains a structured selection, and `resource(block)` forwards an observed resource.
Text, console lines and resources keep their call order. A defined explicit return
or final expression overrides the selection, including null, false and zero;
an undefined result leaves the last `value()` selection intact. Structured output
is visible in Nexus UI task inspection and is never rendered to the model;
use `text(JSON.stringify(result))` for results the model needs to read. Keep a successful
result instead of repeating the tool call just to display it. Native tool failures expose their message; Nexus helper
refusals also expose `error.refusal`. Host transport failures terminate execution.

Ordinary tool Promises have no `operation_key`. Use an explicit handle when work
needs cancellation, joining, replacement or background ownership:

```javascript
const work = await nexus.start({ kind: "model", input: { prompt: "Inspect the project" } })
await nexus.background({ operation_key: work.operation_key, lifetime: "conversation", wake: "auto" })
text("The result will arrive when ready.")
```

`nexus.wait(work)` waits for an explicit handle. The model, ask, steps, replace,
cancel, join and background helpers remain available. Only a confirmed background
transfer releases ownership. Unfinished attached operations are cancelled when the
program ends; accepted effects are never replayed after losing the interpreter.
Source is bounded to 256 KiB, context/events to 8 MiB and output to 1 MiB. Native
execution has a ten-minute wall-clock budget, including waits, and uses OpenCode's
structural limits rather than a separate engine heap limit.

## Reusable executor API

`@opencode/nexus-runtime/experimental/executor` exports `NexusExecutor`,
`ExecutorOptions`, `RunnerAdmission`, `ClaimJournal`, and the runner/orchestration
types. This API is experimental and may change without compatibility guarantees.
A host supplies its SDK `ExecutorClient`, executor `id`, `storage`, `root`, and
`extensions: () => RunnerTool[]`; optional host services provide shell and PTY work.
No Human credential or managed application is required.

`start()` follows HTTP recovery and optional SDK `realtime` hints until shutdown;
it returns the lifetime Promise. `notify`, `sweep`, `drain`, `snapshot`, `setRoot`
and idempotent `close` are available for host integration. The host announces its
catalog through the SDK before starting. `roles` selects agent, runner and/or
tool_provider; provider pool rows can have a null executor target. `placement`
is captured by default; fixed placement uses the host's root. `builtin: false`
restricts execution to supplied extension tools. Multiple owners may share an
admission object and retain resource permits through actual handler completion.

Tool and worker contexts receive `orchestration.start(key, request)`, `wait(handle)`,
`ask(key, prompt, options?)`, and `run({code, params?})`. These capabilities retain
the current claim, frozen declarations and cancellation signal without exposing
credentials. `run` uses native OpenCode Code Mode and refuses reconstruction of
an invocation with existing operation history. The managed runtime uses this same
executor owner.

## Development controls

The development extension is source-only. Load its absolute path through
`OPENCODE_NEXUS_EXTENSIONS` as a JSON array (for example,
`["/absolute/opencode/packages/nexus-runtime/dev/extension.ts"]`), then invoke
its terminal from this package:

```sh
bun dev/cli.ts help
bun dev/cli.ts runners
bun dev/cli.ts web.fetch https://example.com/ --raw
```

The terminal discovers the elected OpenCode service. Its operations use the same
admission receipts, approval owner, environment records and conversation services
as the application. Live streams retain cursors and follow fallback runs; Ctrl-C
detaches the terminal without canceling accepted work. Web fetch prints a complete
rendering or binary bytes to stdout and its status to stderr.

## Rho correspondence

The reference baseline, contract anchors, accepted native differences and verification
evidence are recorded in [PARITY.md](./PARITY.md). These are TypeScript implementations
hosted by OpenCode's managed service; the Rho web UI is replaced by `nexus-ui`.

| Reference                 | TypeScript implementation and contracts                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rho application           | Pairing and Human credentials, shared durable admission, input-specific recovery, operations, Presets/roles, Bots, Until graph checks, memory policy/review, captured conventions, capability settings and extension lifecycle |
| rho extension packages    | Immutable install/check/activate/disable/rollback, configuration migration and redaction, staged registration, retained handler leases, commands, tools and documents                                                          |
| rho-env executor          | Authoritative claims, startup admission, resources, cancellation, captured placement, refusal floor, renewal and settlement recovery                                                                                           |
| rho-env files/checkpoints | Streaming reads and attachments, fuzzy edits, bounded search, SQLite content-addressed checkpoints, restore/undo, retention, Git review and skill discovery                                                                    |
| rho-env terminal          | OpenCode PTY ownership, TypeScript ICE/DTLS/SCTP, permission expiry, reconnect and output replay, configurable ICE/TURN/network settings                                                                                       |
| rho-codemode              | Native OpenCode Code Mode, frozen Nexus operations and background receipts, copied JSON bindings, explicit output/resource selection, native execution limits                                                                  |
| rho-web-tools             | DNS-pinned bounded fetch, authority grants, redirect policy, charset/decompression handling, Markdown/media publication and operator fetch                                                                                     |
| rho-browser               | Private Chromium, per-run tabs, cross-frame accessibility refs, actionability checks, popup ownership, screenshots, cancellation and idle cleanup                                                                              |
| rho-mcp                   | Scoped OpenCode transports, per-role defaults, tool curation/budgets, prompt/resource documents, OAuth and narrow client capabilities                                                                                          |
| rho-acp                   | Editor authentication, new/load/resume/configuration, history replay, questions/permissions, multimodal prompts, unsaved-buffer bridge and session MCP                                                                         |
| rho-acp-client            | Resident conversation-owned children, fixed session placement, live progress, authentication/model selection, refusal floor, transcript capture and process retirement                                                         |
| rho-ingress-telegram      | Connections/Bots, private/group/topic routing, requester ACLs, durable debounce/admission/delivery, media/voice, scheduling, participation and exact worker result tracking                                                    |
| rho-dev                   | Source-only development extension and CLI over shared application operations                                                                                                                                                   |
| rho-webui                 | Replaced by `packages/nexus-ui`                                                                                                                                                                                                |

See [the behavioral correspondence ledger](PARITY.md) for reference contracts,
production owners, executable evidence and intentional OpenCode substitutions.

## Capability verification

Each row below names the production owner and the local behavioral tests for the
corresponding Rho package. The implementation uses OpenCode's service, filesystem,
process, PTY and MCP facilities. Installation, upgrade and remote-access operations
use OpenCode's existing commands. The Rho WebUI is replaced by `nexus-ui`.

| Rho package            | Production owner                                                                             | Executable verification                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rho`                  | runtime, application, settings, adaptations, titles, Presets/Bots, extensions, memory, Until | `runtime`, `application`, `adaptations`, `conversation-titles`, `run`, `presets`, `bots`, `lifecycle`, `packages`, `memory-review`, `until` tests              |
| `rho-env`              | runner inbox/claims, files/search, checkpoints, processes, skills, terminal                  | `executor`, `claim-control`, `claim-result`, `runner`, `attachments`, `runner-search`, `checkpoint-store`, `processes`, `skills`, `terminal`, `realtime` tests |
| `rho-codemode`         | native OpenCode Code Mode and frozen operation bridge                                        | `code`, `executor` tests                                                                                                                                       |
| `rho-web-tools`        | bounded DNS-pinned fetch and publication                                                     | `web` tests                                                                                                                                                    |
| `rho-browser`          | Chromium session and browser tools                                                           | `browser` tests with real Chromium                                                                                                                             |
| `rho-mcp`              | OpenCode transport adapter, curation, documents and OAuth                                    | `mcp`, `mcp-exchange`, `mcp-session`, `mcp-sessions`, `captured-mcp` tests                                                                                     |
| `rho-acp`              | editor sessions, auth, environment bridge and replay                                         | `editor`, `editor-replay`, `editor-permissions`, `editor-auth`, plus Nexus UI bridge reply tests                                                               |
| `rho-acp-client`       | resident child delegation and permission policy                                              | `acp`, `adapters`, `runner-policy` tests                                                                                                                       |
| `rho-ingress-telegram` | connections, ingress, scheduling and exact worker delivery                                   | `telegram`, `telegram-workers`, `telegram-cross-bot`, `telegram-render`, `telegram-transport` tests                                                            |
| `rho-dev`              | source-only extension, streams and terminal                                                  | `dev`, `dev-worker` tests                                                                                                                                      |

All named tests live under `test/` with `.test.ts` suffixes. Run `bun run
test:conformance` with `OPENCODE_NEXUS_CHROMIUM` set to exercise the complete local
suite without silently skipping browser or WebRTC checks. CI runs this gate on Linux
when the runtime is affected. External integrations use local HTTP/WebSocket fixtures
and real local processes; this gate makes no live Nexus or Telegram account changes.

## Verification

`executor.test.ts` exercises the actual executor SDK over loopback HTTP: direct
claims without listing, startup saturation, a real Code Mode/native file child
with one startup slot, cancellation across pool replacement, role/placement
refusals, lost settlement responses, throttled delivery and credential loss.
`claim-control.test.ts` controls time for renewal and execution/settlement clocks;
`claim-result.test.ts` verifies storable values and serialized output bounds.
Worker tests exercise actual blocked JavaScript, replacement and sibling
cancellation. The development extension runs against real loopback HTTP and
WebSocket SDK fixtures across the worker boundary, and a Node garbage-collection
fixture verifies remote object and abort-signal release.

`acp.test.ts` uses real SDK child processes for resident sessions, ownership,
authentication/model configuration, fixed placement, probe/kill/release,
permission tracking, delayed approvals, cancellation quarantine and late output,
deadline termination, startup retirement, migration and redacted transcript
publication. `runner-policy.test.ts` checks the shared literal refusal floor;
`executor.test.ts` also checks it at the native claim boundary.

`presets.test.ts`, `bots.test.ts` and `application.test.ts` exercise the actual
TypeScript SDK over loopback HTTP, including compare-and-swap conflicts, lost
committed responses, fresh runtime instances, archived old roots and fallback
selection. `browser.test.ts` uses real Chromium for cookie sharing, tab isolation,
serialization, stale refs, idle retirement, PNGs, cancellation and popup cleanup.
The Nexus UI bridge seals the compiled configuration into its existing reply
ticket; this is covered by `server/reply.test.ts` in that repository. No Rho web UI
implementation or new management screens are included.

Run `bun run test`, `bun typecheck`, `bun run typecheck:tsc` and `bun run build`
from this package. Setting `OPENCODE_NEXUS_CHROMIUM` exercises the browser adapter and real Chromium WebRTC interoperability. WebRTC peer tests run without
a Go helper or native WebRTC addon.

Protocol changes require client generation from `packages/client`. The final
repository gate is `bun run check` from the root. Use a distinct test identity
and scratch directory for live restart, cancellation and mutation journeys.
