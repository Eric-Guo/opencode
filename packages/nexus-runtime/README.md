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
out of claim renewal for a tool with its own hard deadline.

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

## ACP editor surface

`opencode nexus acp` exposes Nexus conversations over ACP. `--mode ask|bypass|rules`,
`--model provider/model` and `--runner EXECUTOR_ID` seed new sessions. Saved model
and approval choices win on load/resume. The surface advertises built-in commands
and discovered skills, captures editor roots, and submits through shared runtime
admission with the signed-in Human credential. Closing the client releases its
editor filesystem and MCP attachments while accepted work remains owned by Nexus.

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
First use seeds Probius and Adjutant plus the published worker, planner, explorer
and reviewer roles. Creating or duplicating a Preset does not publish a role.

Use the existing management command or `POST /api/experimental/nexus/manage`:

```sh
opencode nexus manage --json '{"action":"preset.list"}'
opencode nexus manage --json '{"action":"preset.create","value":{"name":"Writer","description":"Draft reports","configuration":{"system_prompt":"Draft clear reports.","fallback_models":[]}}}'
opencode nexus manage --json '{"action":"bot.create","name":"assistant","description":"Personal assistant","settings":{"home_workspace_public_id":"WORKSPACE_ID"}}'
opencode nexus manage --json '{"action":"bot.list"}'
```

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
`application.skills` returns the available skill names and descriptions for ACP. The exported
application follower recovers the requested input and its fallback chain through
SDK HTTP replay, independently of realtime delivery. Persona read/write/reset
uses the separately stored Human platform credential established by `nexus login`.

## Browser lifecycle

Browser activation checks the configured Chromium executable before exposing
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
`swept`, `nudged`, `canceled` and the latest `issue` type/code. In-flight ownership
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
process deadline and bounded output. The Agent's `list_extensions` and
`manage_extension` tools expose these operations. Credentials in configuration
and schema annotations are redacted. Invalid saved fields retain valid siblings
and fall back independently; configuration diagnostics identify paths without
including their values.

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

Code Mode preserves Rho's JavaScript binding ID. Each invocation uses an isolated
QuickJS heap with ordinary JavaScript functions, classes and Promises. It has no
ambient filesystem, network, clock or randomness. The host accepts each issued
operation batch before delivering observations, and only host-observed resources
can enter the final envelope. Child operations must settle or transfer ownership
through an accepted background receipt.

The limits are 256 KiB of source, 8 MiB of context or incoming events, 1 MiB of
output/pending requests, a 64 MiB heap and one second of computation per VM
invocation. Host waits do not spend the computation budget. The embedded WASM
variant bundles into the Node service without a separate asset file.

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

The reference is `agents/rho` at Cybros revision
`31b82029d75d1ed9626b80739e4caca16671b344`. These are TypeScript implementations
hosted by OpenCode's managed service; the Rho web UI is replaced by `nexus-ui`.

| Reference                 | TypeScript implementation and contracts                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rho application           | Pairing and Human credentials, shared durable admission, input-specific recovery, operations, Presets/roles, Bots, Until graph checks, memory policy/review, captured conventions, capability settings and extension lifecycle |
| rho extension packages    | Immutable install/check/activate/disable/rollback, configuration migration and redaction, staged registration, retained handler leases, commands, tools and documents                                                          |
| rho-env executor          | Authoritative claims, startup admission, resources, cancellation, captured placement, refusal floor, renewal and settlement recovery                                                                                           |
| rho-env files/checkpoints | Streaming reads and attachments, fuzzy edits, bounded search, SQLite content-addressed checkpoints, restore/undo, retention, Git review and skill discovery                                                                    |
| rho-env terminal          | OpenCode PTY ownership, TypeScript ICE/DTLS/SCTP, permission expiry, reconnect and output replay, configurable ICE/TURN/network settings                                                                                       |
| rho-codemode              | Isolated JavaScript binding, exact operation ordering and ownership receipts, immutable JSON values, explicit output/resource selection, CPU/heap/data budgets                                                                 |
| rho-web-tools             | DNS-pinned bounded fetch, authority grants, redirect policy, charset/decompression handling, Markdown/media publication and operator fetch                                                                                     |
| rho-browser               | Private Chromium, per-run tabs, cross-frame accessibility refs, actionability checks, popup ownership, screenshots, cancellation and idle cleanup                                                                              |
| rho-mcp                   | Scoped OpenCode transports, per-role defaults, tool curation/budgets, prompt/resource documents, OAuth and narrow client capabilities                                                                                          |
| rho-acp                   | Editor authentication, new/load/resume/configuration, history replay, questions/permissions, multimodal prompts, unsaved-buffer bridge and session MCP                                                                         |
| rho-acp-client            | Resident conversation-owned children, fixed session placement, live progress, authentication/model selection, refusal floor, transcript capture and process retirement                                                         |
| rho-ingress-telegram      | Connections/Bots, private/group/topic routing, requester ACLs, durable debounce/admission/delivery, media/voice, scheduling, participation and exact worker result tracking                                                    |
| rho-t3                    | Native service setup, provider catalog and authentication, persistent assignment handles, uncertain launch reconciliation, fork isolation and callbacks                                                                        |
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
| `rho-codemode`         | isolated QuickJS and frozen operation bridge                                                 | `code`, `executor` tests                                                                                                                                       |
| `rho-web-tools`        | bounded DNS-pinned fetch and publication                                                     | `web` tests                                                                                                                                                    |
| `rho-browser`          | Chromium session and browser tools                                                           | `browser` tests with real Chromium                                                                                                                             |
| `rho-mcp`              | OpenCode transport adapter, curation, documents and OAuth                                    | `mcp`, `mcp-exchange`, `mcp-session`, `mcp-sessions`, `captured-mcp` tests                                                                                     |
| `rho-acp`              | editor sessions, auth, environment bridge and replay                                         | `editor`, `editor-auth`, plus Nexus UI bridge reply tests                                                                                                      |
| `rho-acp-client`       | resident child delegation and permission policy                                              | `acp`, `adapters`, `runner-policy` tests                                                                                                                       |
| `rho-ingress-telegram` | connections, ingress, scheduling and exact worker delivery                                   | `telegram`, `telegram-workers`, `telegram-cross-bot`, `telegram-render`, `telegram-transport` tests                                                            |
| `rho-t3`               | authenticated RPC, native service and assignment ownership                                   | `t3` tests                                                                                                                                                     |
| `rho-dev`              | source-only extension, streams and terminal                                                  | `dev`, `dev-worker` tests                                                                                                                                      |

All named tests live under `test/` with `.test.ts` suffixes. Run `bun run
test:conformance` with `OPENCODE_NEXUS_CHROMIUM` set to exercise the complete local
suite without silently skipping browser or WebRTC checks. CI runs this gate on Linux
when the runtime is affected. External integrations use local HTTP/WebSocket fixtures
and real local processes; this gate makes no live Nexus, Telegram, or T3 account changes.

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
