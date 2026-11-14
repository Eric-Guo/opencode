# Nexus runtime

OpenCode's managed service hosts the Nexus Agent and Local Runner. The runtime
uses the packaged TypeScript Nexus SDK and OpenCode's host services. Enablement
is controlled by `experimental.nexus_runtime`.

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

`api.registerCommand(name, handler)` exposes an installation-owned management
handler. Commands and tools share registration validation and retirement leases;
a failed candidate publishes neither. Reads and calls use the loaded instance
immediately.

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
children. Service shutdown releases all children. Automatic conversation-ended
release and live progress forwarding remain in the ledger.

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

Preset commands cover read, replacement, duplication, removal, JSON import/export,
role publication and application defaults. Bot commands cover settings, identity,
duplication, history, current/new/resume/fork and submission. Reading a Bot never
creates a conversation. New Bot conversations require a Home Workspace; switching
archives the previous root without canceling its accepted work. External Bots
have no local runner, private MCP or Code Mode access, and require a requester
identity on submission. Changing an External Bot to Personal requires duplication.

`application.open`, `application.submit` and `application.result` expose Main
Agent admission and recovery. Supply a stable operation `key` for mutations.
Submission saves the original model, fallbacks, agent configuration, tools and
executor contexts before posting the input. Retrying that key after an uncertain
response uses the saved declaration; a changed request with the same key fails.
Bot input retries retain their original conversation after a switch. The exported
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

## Rho parity ledger

The reference is `agents/rho` at Cybros revision
`31b82029d75d1ed9626b80739e4caca16671b344`. This ledger records remaining work;
the existing adapter names do not establish complete parity.

| Source                    | Implemented                                                                                                                                                                                                                                                                                                      | Remaining                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rho application           | Pairing, separate credential planes, workspace validation, saved extension activation, shared application admission, frozen retry declarations, input-specific HTTP/fallback following, Human persona operations                                                                                                 | Until recovery, complete follower/approval handling, memory policy/review, remaining management operations                                                 |
| rho Presets/roles         | Durable seeded catalog, CRUD/duplicates/defaults, portable JSON, published roles, tool/fallback compilation, conversation-only child memory                                                                                                                                                                      | Markdown portability, complete MCP reference curation and publication/default conformance                                                                  |
| rho Bots                  | Named identities, settings, audience narrowing, duplication, durable creation/switch intents, Home validation, history/current/new/resume/fork, captured input submission                                                                                                                                        | Complete External requester/peer/Subagent policies, ingress connection ownership, full recovery conformance                                                |
| rho extension packages    | Descriptors, dependencies, staged tool/command registration, schema validation, readiness, cleanup leases, restart-only settings, legacy factory adapter                                                                                                                                                         | Managed immutable package install/check/activate/rollback, persistent source selection, complete hook/document/command APIs, per-field startup diagnostics |
| rho-env executor          | Direct notification claims, bounded startup admission and cursor sweeps, run/task cancellation, persistent resource leases, schema/role/admission gates, shared refusal floor, renewable claims with delivery headroom, bounded storable results, commit reconciliation/retry, journal recovery, status counters | Captured multi-directory placement, isolation for blocking extension handlers, remaining crash/timeout/platform recovery journeys                          |
| rho-env files/checkpoints | Basic file/search/shell tools, attachments, partial JSON/Git checkpoint restoration                                                                                                                                                                                                                              | SQLite manifest/content store, capture budgets/retention, full media/skill/process/Git review behavior                                                     |
| rho-env terminal          | OpenCode PTY adapter, TypeScript ICE/DTLS/SCTP transport, permission channel, output resume/gap window, claim-scoped terminal session                                                                                                                                                                            | Complete browser-to-PTY reconnect/permission-expiry journeys, configurable ICE/TURN/network settings, remote operator integration                          |
| rho-codemode              | OpenCode interpreter, frozen tool catalog, awaitable readonly operation handles, complete outcomes, explicit output/resource selection, background ownership receipts                                                                                                                                            | Computation-only budgets between waits, complete authoring/model-default validation, all ordering and cancellation conformance cases                       |
| rho-web-tools             | Bounded fetch, public-address filtering, HTML conversion and attachments                                                                                                                                                                                                                                         | Complete redirect/grant/cancellation conformance and CLI fetch                                                                                             |
| rho-browser               | Shared Chromium context, per-run tabs and serialization, accessibility snapshot refs, readiness probe, idle cleanup, popup ownership, cancellation isolation, actions/evaluation/PNG attachments                                                                                                                 | Cross-frame/actionability parity, timeout/crash and popup edge-case conformance on all supported platforms                                                 |
| rho-mcp                   | Selected OpenCode servers, tool execution and media publication                                                                                                                                                                                                                                                  | Full tool curation, Agent/Runner transport defaults, declaration budgets, prompt/resource documents, lifecycle and OAuth refresh conformance               |
| rho-acp                   | Basic editor sessions, prompts, questions, permissions and cancellation                                                                                                                                                                                                                                          | Authentication, replay/load/resume/configuration, multimodal/editor filesystem/session-MCP and recovery parity                                             |
| rho-acp-client            | Resident conversation-owned children, explicit continuation and birth workdir, authentication/model selection, row settings/diagnostics, shared permission floor, redacted bounded transcripts, ordinary cancellation quarantine, hard termination, roster/probe/session/log/kill/release commands               | Automatic conversation-ended release, live progress forwarding, complete crash/process-tree/platform lifecycle conformance                                 |
| rho-ingress-telegram      | Allowlisted private chats, attachments, basic controls and persisted pending delivery                                                                                                                                                                                                                            | Connections/Bots/groups/topics, durable debounce, access and requester policies, memory/voice and complete delivery recovery                               |
| rho-t3                    | Host RPC adapter, coding assignment controls, questions and artifacts                                                                                                                                                                                                                                            | Owned local service/setup, complete provider selection, persistent handles and uncertain-response reconciliation                                           |
| rho-dev                   | Runtime management commands                                                                                                                                                                                                                                                                                      | Development-only conversation inspection/control extension                                                                                                 |
| rho-webui                 | Replaced by nexus-ui                                                                                                                                                                                                                                                                                             | New management screens are outside this port                                                                                                               |

## Verification

`executor.test.ts` exercises the actual executor SDK over loopback HTTP: direct
claims without listing, startup saturation, a real Code Mode/native file child
with one startup slot, cancellation across pool replacement, role/placement
refusals, lost settlement responses, throttled delivery and credential loss.
`claim-control.test.ts` controls time for renewal and execution/settlement clocks;
`claim-result.test.ts` verifies storable values and serialized output bounds.

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
from this package. Setting `OPENCODE_NEXUS_CHROMIUM` also exercises the browser
adapter and real Chromium WebRTC interoperability. WebRTC peer tests run without
a Go helper or native WebRTC addon.

Protocol changes require client generation from `packages/client`. The final
repository gate is `bun run check` from the root. Use a distinct test identity
and scratch directory for live restart, cancellation and mutation journeys.
