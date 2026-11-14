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

## Rho parity ledger

The reference is `agents/rho` at Cybros revision
`31b82029d75d1ed9626b80739e4caca16671b344`. This ledger records remaining work;
the existing adapter names do not establish complete parity.

| Source                    | Implemented                                                                                                                                                           | Remaining                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rho                       | Pairing, separate credential planes, workspace validation, basic policy, saved extension configuration and asynchronous activation                                    | Shared application service, Bots/Presets/roles/persona, full input/follower and Until recovery, memory policy/review, complete management operations       |
| rho extension packages    | Descriptors, dependencies, staged registration, schema validation, readiness, cleanup leases, restart-only settings, legacy factory adapter                           | Managed immutable package install/check/activate/rollback, persistent source selection, complete hook/document/command APIs, per-field startup diagnostics |
| rho-env executor          | Renewable claims, transient status-read tolerance, shared child-operation observation cursor, acceptance reconciliation, resource admission, journal recovery         | Direct notification claims, bounded startup admission, full captured multi-directory placement, complete failure classification and recovery journeys      |
| rho-env files/checkpoints | Basic file/search/shell tools, attachments, partial JSON/Git checkpoint restoration                                                                                   | SQLite manifest/content store, capture budgets/retention, full media/skill/process/Git review behavior                                                     |
| rho-env terminal          | OpenCode PTY adapter, TypeScript ICE/DTLS/SCTP transport, permission channel, output resume/gap window, claim-scoped terminal session                                 | Complete browser-to-PTY reconnect/permission-expiry journeys, configurable ICE/TURN/network settings, remote operator integration                          |
| rho-codemode              | OpenCode interpreter, frozen tool catalog, awaitable readonly operation handles, complete outcomes, explicit output/resource selection, background ownership receipts | Computation-only budgets between waits, complete authoring/model-default validation, all ordering and cancellation conformance cases                       |
| rho-web-tools             | Bounded fetch, public-address filtering, HTML conversion and attachments                                                                                              | Complete redirect/grant/cancellation conformance and CLI fetch                                                                                             |
| rho-browser               | Chromium navigation, snapshots, actions, evaluation and screenshots                                                                                                   | Shared Playwright context, per-loop tabs/serialization, snapshot refs, readiness checks and idle/popup lifecycle                                           |
| rho-mcp                   | Selected OpenCode servers, tool execution and media publication                                                                                                       | Full tool curation, Agent/Runner transport defaults, declaration budgets, prompt/resource documents, lifecycle and OAuth refresh conformance               |
| rho-acp                   | Basic editor sessions, prompts, questions, permissions and cancellation                                                                                               | Authentication, replay/load/resume/configuration, multimodal/editor filesystem/session-MCP and recovery parity                                             |
| rho-acp-client            | Configured child launch, prompt, one-shot permission relay                                                                                                            | Resident conversation sessions, continuation/auth/model configuration, policy floor, transcripts and cancellation lifecycle                                |
| rho-ingress-telegram      | Allowlisted private chats, attachments, basic controls and persisted pending delivery                                                                                 | Connections/Bots/groups/topics, durable debounce, access and requester policies, memory/voice and complete delivery recovery                               |
| rho-t3                    | Host RPC adapter, coding assignment controls, questions and artifacts                                                                                                 | Owned local service/setup, complete provider selection, persistent handles and uncertain-response reconciliation                                           |
| rho-dev                   | Runtime management commands                                                                                                                                           | Development-only conversation inspection/control extension                                                                                                 |
| rho-webui                 | Replaced by nexus-ui                                                                                                                                                  | New management screens are outside this port                                                                                                               |

## Verification

Run `bun run test`, `bun typecheck`, `bun run typecheck:tsc` and `bun run build`
from this package. Setting `OPENCODE_NEXUS_CHROMIUM` also exercises the browser
adapter and real Chromium WebRTC interoperability. WebRTC peer tests run without
a Go helper or native WebRTC addon.

Protocol changes require client generation from `packages/client`. The final
repository gate is `bun run check` from the root. Use a distinct test identity
and scratch directory for live restart, cancellation and mutation journeys.
