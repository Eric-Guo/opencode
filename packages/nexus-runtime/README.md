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

Registration stages tools and cleanup handlers before publication. A failed
registration releases its resources and leaves working extensions available.
Running handlers retain their original extension instance until they exit.
`RunnerTool.resource` declares shared local concurrency; `internalTimeout` opts
out of claim renewal for a tool with its own hard deadline.

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

## Rho parity ledger

The reference is `agents/rho` at Cybros revision
`31b82029d75d1ed9626b80739e4caca16671b344`. This ledger records remaining work;
the existing adapter names do not establish complete parity.

| Source                    | Implemented                                                                                                                                                                                                      | Remaining                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rho application           | Pairing, separate credential planes, workspace validation, saved extension activation, shared application admission, frozen retry declarations, input-specific HTTP/fallback following, Human persona operations | Until recovery, complete follower/approval handling, memory policy/review, remaining management operations                                                 |
| rho Presets/roles         | Durable seeded catalog, CRUD/duplicates/defaults, portable JSON, published roles, tool/fallback compilation, conversation-only child memory                                                                      | Markdown portability, complete MCP reference curation and publication/default conformance                                                                  |
| rho Bots                  | Named identities, settings, audience narrowing, duplication, durable creation/switch intents, Home validation, history/current/new/resume/fork, captured input submission                                        | Complete External requester/peer/Subagent policies, ingress connection ownership, full recovery conformance                                                |
| rho extension packages    | Descriptors, dependencies, staged registration, schema validation, readiness, cleanup leases, restart-only settings, legacy factory adapter                                                                      | Managed immutable package install/check/activate/rollback, persistent source selection, complete hook/document/command APIs, per-field startup diagnostics |
| rho-env executor          | Renewable claims, transient status-read tolerance, shared child-operation observation cursor, acceptance reconciliation, resource admission, journal recovery                                                    | Direct notification claims, bounded startup admission, full captured multi-directory placement, complete failure classification and recovery journeys      |
| rho-env files/checkpoints | Basic file/search/shell tools, attachments, partial JSON/Git checkpoint restoration                                                                                                                              | SQLite manifest/content store, capture budgets/retention, full media/skill/process/Git review behavior                                                     |
| rho-env terminal          | OpenCode PTY adapter, TypeScript ICE/DTLS/SCTP transport, permission channel, output resume/gap window, claim-scoped terminal session                                                                            | Complete browser-to-PTY reconnect/permission-expiry journeys, configurable ICE/TURN/network settings, remote operator integration                          |
| rho-codemode              | OpenCode interpreter, frozen tool catalog, awaitable readonly operation handles, complete outcomes, explicit output/resource selection, background ownership receipts                                            | Computation-only budgets between waits, complete authoring/model-default validation, all ordering and cancellation conformance cases                       |
| rho-web-tools             | Bounded fetch, public-address filtering, HTML conversion and attachments                                                                                                                                         | Complete redirect/grant/cancellation conformance and CLI fetch                                                                                             |
| rho-browser               | Shared Chromium context, per-run tabs and serialization, accessibility snapshot refs, readiness probe, idle cleanup, popup ownership, cancellation isolation, actions/evaluation/PNG attachments                 | Cross-frame/actionability parity, timeout/crash and popup edge-case conformance on all supported platforms                                                 |
| rho-mcp                   | Selected OpenCode servers, tool execution and media publication                                                                                                                                                  | Full tool curation, Agent/Runner transport defaults, declaration budgets, prompt/resource documents, lifecycle and OAuth refresh conformance               |
| rho-acp                   | Basic editor sessions, prompts, questions, permissions and cancellation                                                                                                                                          | Authentication, replay/load/resume/configuration, multimodal/editor filesystem/session-MCP and recovery parity                                             |
| rho-acp-client            | Configured child launch, prompt, one-shot permission relay                                                                                                                                                       | Resident conversation sessions, continuation/auth/model configuration, policy floor, transcripts and cancellation lifecycle                                |
| rho-ingress-telegram      | Allowlisted private chats, attachments, basic controls and persisted pending delivery                                                                                                                            | Connections/Bots/groups/topics, durable debounce, access and requester policies, memory/voice and complete delivery recovery                               |
| rho-t3                    | Host RPC adapter, coding assignment controls, questions and artifacts                                                                                                                                            | Owned local service/setup, complete provider selection, persistent handles and uncertain-response reconciliation                                           |
| rho-dev                   | Runtime management commands                                                                                                                                                                                      | Development-only conversation inspection/control extension                                                                                                 |
| rho-webui                 | Replaced by nexus-ui                                                                                                                                                                                             | New management screens are outside this port                                                                                                               |

## Verification

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
