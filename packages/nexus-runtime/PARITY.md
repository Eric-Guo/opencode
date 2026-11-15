# Rho behavioral correspondence

Reference: `agents/rho` in Cybros revision
`31b82029d75d1ed9626b80739e4caca16671b344`. Paths in the first column are relative
to that directory. Implementation and test paths are relative to this package.
The reference checkout is used for development review only; production and CI
need neither that checkout nor Ruby.

## Application and executor

| Reference contracts                                                                                    | TypeScript owner                                                                                                        | Behavioral evidence                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rho`: shared Core conversation operations, daemon authoring hooks, input execution and recovery       | `application.ts`, `admission.ts`, `operations.ts`, `turn-lifecycle.ts`, `sides.ts`                                      | `application.test.ts`, `lifecycle.test.ts`, `operations.test.ts`, `sides.test.ts`: frozen admissions, fail-closed authors, lost responses, restart, explicit model inheritance, exact input/fallback recovery, retained lifecycle owners                                                                                                     |
| `rho`: identity, API keys, Human login, configuration, adaptations and conversation titles             | `runtime.ts`, `login.ts`, `settings.ts`, `workspaces.ts`, `adaptations.ts`, `conversation-titles.ts`                    | `runtime.test.ts`, `login.test.ts`, `configuration.test.ts`, `adaptations.test.ts`, `conversation-titles.test.ts`: credential separation, candidate validation, private persistence, field fallback, model spellings, one title attempt and manual-title precedence                                                                          |
| `rho`: Presets, role declarations, Bot policy and switching                                            | `presets.ts`, `bots.ts`, `bot-policy.ts`, `mutation.ts`                                                                 | `presets.test.ts`, `bots.test.ts`, `policy.test.ts`: compare-and-swap, portable definitions, lost committed responses, archived prior roots, external audience restrictions and requester identity                                                                                                                                           |
| `rho`: memory review/policy, Until, instructions and process ownership                                 | `memory-review.ts`, `memory-policy.ts`, `until.ts`, `conventions.ts`, `processes.ts`                                    | `memory-review.test.ts`, `until.test.ts`, `conventions.test.ts`, `processes.test.ts`: captured revisions, private review forks, acceptance graph recovery, bounded instructions and conversation-owned process retirement                                                                                                                    |
| `rho`: extension registration, settings changes and managed packages                                   | `extension-manager.ts`, `configuration.ts`, `packages.ts`, `worker-extension.ts`, `extension-rpc.ts`, `webui-module.ts` | `extensions.test.ts`, `packages.test.ts`, `worker-extension.test.ts`, `extension-rpc-lifetime.test.ts`: inert disabled code, staged publication, failed-candidate cleanup, retained handler leases, immutable versions, rollback, worker cancellation and remote-reference release                                                           |
| `rho-env`: executor inbox, authoritative claims, admission, orchestration, cancellation and settlement | `runner-inbox.ts`, `runner.ts`, `claim-control.ts`, `claim-result.ts`, `claims.ts`                                      | `executor.test.ts`, `claim-control.test.ts`, `claim-result.test.ts`, `claims.test.ts`: push/HTTP recovery, bounded startup/resources, nested child progress, placement/refusal checks, renewal, canceled-handler ownership and durable settlement without rerunning effects                                                                  |
| `rho-env`: filesystem tools, attachments, checkpoints, environments, skills and terminal transport     | `file-read.ts`, `runner-search.ts`, `checkpoint-store.ts`, `environments.ts`, `skills.ts`, `terminal.ts`, `realtime.ts` | `runner.test.ts`, `runner-search.test.ts`, `attachments.test.ts`, `checkpoint-store.test.ts`, `environments.test.ts`, `skills.test.ts`, `terminal.test.ts`, `realtime.test.ts`: complete media transfer, protected roots, fuzzy edits, durable undo, captured roots, skill precedence, real PTYs, WebRTC reconnect and bounded output replay |

## Extensions and peer surfaces

| Reference contracts                                                                                                     | TypeScript owner                                                                                               | Behavioral evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rho-codemode`: JavaScript binding, frozen catalog, operation receipts and observations                                 | `code.ts`, `code-driver.ts`, `claim-control.ts`                                                                | `code.test.ts`, `executor.test.ts`: native Promise ordering, refusal/error distinctions, immutable JSON, accepted background ownership, observed-resource forwarding, isolated CPU/heap/data limits and a real native child with one startup slot                                                                                                                                                                                                                           |
| `rho-web-tools`: fetch policy, renderer, captures and operator fetch                                                    | `web.ts`, `approval-grant.ts`, development terminal                                                            | `web.test.ts`, `dev.test.ts`, `policy.test.ts`: bounded same-site redirects, DNS/address filtering, compression/charset handling, whole content-addressed captures, cancellation, literal authority grants and raw operator output                                                                                                                                                                                                                                          |
| `rho-browser`: browser/tab ownership, actions, snapshots and cleanup                                                    | `browser.ts`, `browser-session.ts`                                                                             | `browser.test.ts` with Chromium: shared cookies, per-run tabs, serialized actions, stale refs, frame refs, PNG capture, cyclic/deep/non-finite evaluation results, cancellation, idle retirement and popup cleanup                                                                                                                                                                                                                                                          |
| `rho-mcp`: settings, curation, documents, transports, OAuth and conversation mounts                                     | `mcp.ts`, `mcp-settings.ts`, `mcp-curation.ts`, `mcp-exchange.ts`, `mcp-session.ts`, `mcp-sessions.ts`         | `mcp.test.ts`, `mcp-exchange.test.ts`, `mcp-session.test.ts`, `mcp-sessions.test.ts`, `captured-mcp.test.ts`: exact names/budgets, isolated bad rows, media/results, narrow client capabilities, transport cancellation, session replacement and captured attachment anchors; post-login catalog publication without restarting unchanged servers; OAuth credential completion and refresh also use the Core `integration.test.ts` and `integration-refresh.test.ts` suites |
| `rho-acp`: authentication, sessions, config, slash commands, history, held questions and editor facilities              | `editor.ts`, `editor-auth.ts`, `editor-bridge.ts`, `editor-replay.ts`, CLI adapter                             | `editor.test.ts`, `editor-replay.test.ts`, `editor-permissions.test.ts`, `editor-auth.test.ts`, `runtime.test.ts`, CLI `nexus.test.ts`: authored Human admission, launch defaults, skill commands, fixed roots, paginated role-aware replay, Side context, owned held-work recovery, shared grants, permission cancellation, unsaved buffers and detachment without canceling work                                                                                          |
| `rho-acp-client`: resident delegation, permission floor, captures and process lifecycle                                 | `acp.ts`, `acp-child.ts`, `acp-policy.ts`, `acp-capture.ts`                                                    | `acp.test.ts`, `adapters.test.ts`, `runner-policy.test.ts`: real child sessions, auth/model selection, protected commands/paths, redaction, permission tracking, cancellation quarantine, deadline termination and host-ended release                                                                                                                                                                                                                                       |
| `rho-ingress-telegram`: Connections/Bots, routing/access, durable ingress/delivery, media, schedules and worker results | `telegram.ts`, `telegram-ingress.ts`, `telegram-transport.ts`, `telegram-workers.ts`, related Telegram modules | `telegram.test.ts`, `telegram-workers.test.ts`, `telegram-cross-bot.test.ts`, `telegram-render.test.ts`, `telegram-transport.test.ts`: requester isolation, debounce, frozen admissions, fixed reply destination, uncertain-send handling, media/voice, schedules, participation and exact canonical worker ownership                                                                                                                                                       |
| `rho-t3`: native setup, authenticated RPC, catalogs and assignment ownership                                            | `t3.ts`, `t3-native.ts`, `t3-catalog.ts`, `t3-transport.ts`                                                    | `t3.test.ts`: protocol/auth checks, native settings preservation, no automatic mutation replay, persistent handles, uncertain-launch reconciliation, fork isolation, model substitution refusal and one-shot callbacks                                                                                                                                                                                                                                                      |
| `rho-dev`: opt-in conversation controls, streams and terminal rendering                                                 | `dev/extension.ts`, `dev/streams.ts`, `dev/terminal.ts`, `operations.ts`                                       | `dev.test.ts`, `dev-worker.test.ts`, `operations.test.ts`: shared application operations, stream cursors, fallback chains, ownership, cancellation/detachment and worker-bound SDK streams                                                                                                                                                                                                                                                                                  |

## Reference contract anchors

All eleven executable non-WebUI packages have production TypeScript owners above.
These reference tests identify the behavioral contracts; the corresponding local
suites exercise the OpenCode implementation rather than executing Ruby.

| Package                | Reference anchors beneath its `test/` directory                                                                                                                      | Local evidence beneath `test/`                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `rho`                  | `api_key_connection_test.rb`, `host_follower_test.rb`, `execution_policy_test.rb`, `package_activation_test.rb`, `memory_review_test.rb`, `until_test.rb`            | `runtime`, `application`, `lifecycle`, `packages`, `memory-review`, `until`                   |
| `rho-env`              | `runner_execution_test.rb`, `claim_orchestration_test.rb`, `cancellation_recovery_test.rb`, `files_test.rb`, `checkpoints/store_test.rb`, `webrtc_transport_test.rb` | `executor`, `claims`, `runner`, `checkpoint-store`, `terminal`, `realtime`                    |
| `rho-codemode`         | `code_test.rb`, `runtime_test.rb`, `claim_bridge_test.rb`                                                                                                            | `code`, `executor`                                                                            |
| `rho-web-tools`        | `client_test.rb`, `render_test.rb`, `commands_test.rb`                                                                                                               | `web`, `policy`, `dev`                                                                        |
| `rho-browser`          | `tools_test.rb`, `session_test.rb`, `session_idle_test.rb`, `session_popups_test.rb`                                                                                 | `browser` with real Chromium                                                                  |
| `rho-mcp`              | `curation_test.rb`, `documents_test.rb`, `post_login_refresh_test.rb`, `conversations_test.rb`                                                                       | `mcp`, `mcp-session`, `mcp-sessions`, `mcp-exchange`, `captured-mcp`                          |
| `rho-acp`              | `acp/reference_replay_test.rb`, `acp/recovery_attach_test.rb`, `acp/permissions_test.rb`, `acp/materialization_test.rb`                                              | `editor-replay`, `editor-permissions`, `editor`, `application`, `runtime`                     |
| `rho-acp-client`       | `tool_test.rb`, `policy_test.rb`, `cancel_reuse_test.rb`, `child_retirement_test.rb`                                                                                 | `acp`, `adapters`, `runner-policy`                                                            |
| `rho-ingress-telegram` | `routing_test.rb`, `input_batch_test.rb`, `recovery_test.rb`, `delivery_test.rb`, `worker_result_delivery_test.rb`                                                   | `telegram`, `telegram-workers`, `telegram-cross-bot`, `telegram-render`, `telegram-transport` |
| `rho-t3`               | `catalog_test.rb`, `setup_test.rb`, `work_test.rb`, `stop_test.rb`, `session_test.rb`                                                                                | `t3`                                                                                          |
| `rho-dev`              | `dev_commands/inspection_test.rb`, `dev_commands/execution_test.rb`, `dev_commands/stream_test.rb`, `dev_commands/conversations_test.rb`                             | `dev`, `dev-worker`, `operations`                                                             |

Local evidence names use the `.test.ts` suffix. `rho-webui` belongs to
`packages/nexus-ui`; its bridge's `server` suite verifies runtime admission,
Human access checks and reply tickets. The UI keeps host-controlled document titles and model-management policy. It now allows explicit expansion beyond the initial nine-dialog window.

ACP replay emits a Side reference once as labelled user context, skips summaries
and preserves user/assistant roles across pages. Load remembers the latest owned
assistant execution, preferring its running variant; resume recovers a missing
target lazily for retry/abandon without replaying text. Inherited and reference
history never becomes a command target.

ACP approval uses `application.approve` through the experimental management API,
with paired-origin Human credentials and conversation/run ownership checks.
The existing approval owner derives literal command/path, native web-fetch site,
or remote MCP callable rules from the held task. A successful one-time approval
and a failed grant declaration are reported separately. Permission-card cancellation
leaves the task undecided and suppresses that card while following; explicit
session cancellation stops the conversation. Editor close only detaches.

MCP login encodes Core's typed OAuth attempt before returning JSON. The local
OAuth fixture completes through the real Integration and Credential services in
private temporary storage, then verifies newly published tools and preservation
of the other server's connection.

## OpenCode substitutions

- Approval defaults remain `ask`. ACP accepts `--mode bypass|ask|rules`; `--model`
  and `--runner` seed new sessions. Saved session choices survive load/resume.
- Nexus UI replaces `rho-webui`. Its bridge retains Human access checks and
  request-bound reply tickets. `application.prepare` durably captures policy and
  author-hook output without posting an input; `application.submit` reuses it.
  Both bind the request to its Human principal. The new ticket version rejects
  old prepared tickets so they must be prepared again after upgrading.
- CLI, ACP and Nexus UI use the same admission owner. Telegram and development
  controls already use the shared application. Preparation/submission retries
  reuse one operation key; changed input or principal is refused. A stricter
  profile's `ask` to `rules` tightening is persisted before the next POST.
- OpenCode owns the managed service, installation/update commands, remote access,
  MCP transports/OAuth, process execution, filesystem services and PTYs. The
  adapters retain Rho's captured placement and accepted-work semantics.
- QuickJS supplies the isolated JavaScript VM. OpenCode's separate code-mode
  interpreter does not provide the same full JavaScript binding, so it is not
  substituted for this execution contract.
- Optional integrations retain their OpenCode configuration and enablement
  defaults. Settings are not imported from Rho homes. Native T3 and delegated
  coding agents remain external optional programs.
- `rho-dev` is source-only. The reference `rho-runner` directory has no tracked
  implementation; runner behavior is supplied by `rho-env`.

## Verification boundary

Run `bun run test:conformance` with `OPENCODE_NEXUS_CHROMIUM` pointing at an isolated
Chromium executable. This exercises the production owners with local HTTP,
WebSocket, MCP and child-process fixtures, including real Chromium and WebRTC.
The Nexus UI bridge has its own `server` suite and fixture-driven browser journeys for management, module lifecycle and chat; the CLI and Server adapters have
package-local `nexus.test.ts` suites. CI's runtime conformance job installs Chromium.

These checks establish local behavior. Live account provisioning and live Nexus,
Telegram and T3 deployment interoperability require isolated integration identities;
the automated gate makes no changes to those accounts. They do not establish
byte-for-byte Ruby implementation equivalence or identical CLI/configuration names.

## Added native surface correspondence

- `Workspaces` enumerates active dedicated and shared workspaces with pagination.
  Explicit selections are checked before conversation creation; changing the default
  persists the preference without moving existing conversations. `workspaces.test.ts`
  covers later pages, inactive workspaces and foreign dedication.
- CLI run requests capture their workspace through execution and cancellation.
  Human management operations and UI scopes retain their explicit workspace.
- Schedules capture the selected Ask/Rules/Bypass policy and complete executor
  contexts. Edits use the schedule's lock version; Ask remains the default.
- Human login supports both loopback PKCE and device authorization. Platform
  administration uses the stored Human credential and checks the requested
  principal. `login.test.ts` covers principal separation and path confinement.
- Extension registration can declare an asset directory with `await
api.registerWebUI(absoluteDirectory)`. Managed manifests can declare a relative
  `webui` directory. Publication is staged with the extension; an opaque version
  changes at activation, and disabled or replaced versions stop serving assets.
  `webui-module.test.ts` covers traversal, symlinks and retirement.
- `packages/nexus-ui/src/management` owns the Rho WebUI counterparts: workspace
  selection, Bot setup and conversations, Presets/roles, schedules, schema-driven
  plugin settings, immutable package activation, Telegram/MCP/T3 controls, persona
  and memory review, provider administration, deployment progress and terminals.
  Terminal viewers use the runner-owned PTY, permission DataChannel and byte cursor;
  detaching a viewer does not replay input or create another shell.

The desktop/service authentication boundary replaces Rho's standalone open/password
browser modes. Native module interfaces use TypeScript and OpenCode's scoped bridge;
Rho JavaScript modules need an adapter to this API. Provider and deployment actions
remain subject to Nexus Human permissions. OpenCode installation updates remain
owned by the desktop updater or `opencode upgrade`.

## Executor and extension contract completion

The correspondence includes reusable extension behavior as well as shipped tools.
The runtime remains a managed OpenCode Agent plus Local Runner; standalone
executor-only and tool-provider processes are outside this product topology.
`rho-webui` remains owned by `packages/nexus-ui` and is outside this runtime change.

| Reference contract                                                                                                                                                                                               | TypeScript owner and executable evidence                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rho-env/test/runner_execution_test.rb`, `runner_configuration_test.rb`, `extensions_test.rb`: ordered argument rewrites/vetoes, post-rewrite validation, observer failure and captured hook ownership           | `extension-manager.ts`, `runner-inbox.ts`, `worker-extension.ts`; `extensions`, `executor`, `worker-extension` tests exercise local and worker hooks, retirement and durable results                                                                |
| `rho-env/test/claim_questions_test.rb`, `claim_orchestration_test.rb`: paused submission, exact question reuse, uncertain acceptance and observation cursor recovery                                             | `claim-control.ts`; `claim-control` tests retain the same request and claim, reject changed requests, recover recorded observations and stop sends on cancellation                                                                                  |
| `rho-codemode/test/runtime_test.rb`, `claim_bridge_test.rb`: real acceptance receipts, host failures outside source, one live VM and no source reconstruction                                                    | `code.ts`, `code-driver.ts`, `runner.ts`; `code`, `executor` tests verify receipt mismatch refusal, uncaught host failure, supported bindings, observed resources and nested child execution                                                        |
| `rho/test/extensions/agent_registration_test.rb`, `extensions_test.rb`, `extension_replacement_test.rb`: staged startup, owned backgrounds, registered identities, commands and conversation server registration | `extension-manager.ts`, `registered-agents.ts`, `runtime.ts`; `extensions`, `registered-agents`, `worker-extension` tests cover failed publication, cancellation, ownership after uncertain declarations and restart, model inheritance and removal |
| `rho-browser/test/session_popups_test.rb`: popup ownership and cancellation                                                                                                                                      | `browser-session.ts`; the real Chromium cancellation fixture discards `window.open()`'s non-JSON return value before testing interruption and popup reclamation                                                                                     |

New tool hooks are `experimental.tool.call` and `experimental.tool.result`.
The existing `onToolResult` registration remains supported in the same captured
execution pipeline. Call gates fail closed as completed tool errors; failed result
observers preserve the preceding answer. Placement resolves before hooks, rewritten
arguments pass the declared schema and refusal floor before effects, and checkpoint
capture sees those rewritten arguments. Hook and tool owners stay leased through
actual execution and postprocessing even when cancellation ends the caller's wait.

OpenCode's authenticated `extension.call` operation and `nexus manage` command
replace Rho's extension-specific HTTP routes and Thor command/flag registration.
Command descriptions and optional input schemas are published in extension
inventory. TypeScript extensions register autonomous work with `background`,
initialization with `onStartup`, named definitions with `registerAgent`, and editor
server factories with `registerConversationServers`. Exactly one conversation MCP
registrar may be active. Removing its owner closes its sets and prevents late
publication. Background activities stop on retirement before resource cleanup.
Registered definitions inherit the request model when they omit `default_model`,
retain application ownership across restart, and cannot use the editable Bot prefix.
No Ruby source or local Cybros checkout is required in production or CI.

Validation of this completion used the full local conformance gate, package build,
both TypeScript checkers, generated Protocol/client checks, focused CLI/Server tests,
and the repository check. An authenticated smoke check against local Nexus also
created and removed a temporary named definition with the production TypeScript
registration owner, verifying inherited model selection. Its temporary identity and
ownership ledger were removed; no model request was submitted.

## Second behavioral review

The second pass rechecked every executable non-WebUI package against the same
reference revision, including reusable extension behavior. `rho-runner` still has
no tracked implementation. The confirmed gaps and regression evidence are:

- `rho-mcp` (`connection_test.rb`, `commands_test.rb`, `oauth/connection_test.rb`):
  explicit tool errors and JSON-RPC invalid-argument refusals remain tool results;
  transport failures, other protocol errors and cancellation fail the task. HTTP
  OAuth calls serialize alongside stdio calls, while anonymous/static HTTP calls
  remain concurrent. Probes use a separate scoped connection, including disabled
  rows, without refreshing or invalidating stored OAuth credentials. Enable/disable
  preserves credential identity and unrelated live connections. Sparse row edits
  retain inherited transport settings. Scoped Core logs omit server-controlled
  error details, while model-facing errors use the runtime's credential redactor.
  `mcp`, `mcp-exchange`, `mcp-session`, `configuration` and Core `mcp-oauth` tests
  exercise these paths through real local servers and credential storage.
- `rho-t3` (`lib/rho/t3.rb`): local native ownership marks the active extension
  restart-only; remote service configuration remains replaceable. Extensions can
  call `restartOnly()` during registration. `extensions` and the production Node
  `worker-extension` fixture verify persistence without replacing active resources
  and propagation across the worker bridge.
- `rho-browser` (`session_test.rb`): evaluate invokes function expressions, including
  async functions, as well as evaluating ordinary expressions. The Chromium-backed
  `browser` suite exercises arrow, function and async function forms.
- `rho-acp-client` (`lib/rho/acp-client/call.rb`): delegated tool-call updates and plans
  contribute bounded, redacted progress without becoming final assistant text.
  `acp` exercises this with a real child process.
- `rho-ingress-telegram` (`session_workflow_test.rb`): sessions, resume, archive/restore
  lookup and search enumerate all Bot-history pages. `telegram` verifies the second
  command page through the real application and a paginated Nexus fixture.

The remaining owners (`rho`, `rho-env`, `rho-codemode`, `rho-web-tools`, `rho-acp`
and `rho-dev`) retain their existing contract coverage in the full conformance gate.

This pass passed 283 runtime conformance tests across 66 files with real Chromium
and WebRTC, 174 Core MCP regression tests across four files, both package TypeScript
checkers and the runtime build. The repository-wide `bun run check` passed with its
existing 227 advisory warnings and zero errors.

## Live Nexus end-to-end verification

A source-built OpenCode server with separate storage and a temporary Agent ran
against `http://localhost:3000`, using `deepseek/deepseek-flash` for real model
execution. The existing installed runtime and its pairing were left in place.
The live journeys covered normal and registered-Agent runs, restored credentials
and declarations, Code Mode with native file writes/reads, extension rewrite,
result and veto hooks, Until acceptance steps, cross-workspace Side conversations,
cancellation of a running bash process, unattended approvals and questions, MCP
probe/toggle/execution and Chromium function evaluation. A planned ACP step used
a real child process; both redacted tool and plan tails were observed through
Nexus's WebSocket progress feed before the task completed. MCP and ACP peers were
local fixtures; live Telegram and T3 accounts were outside this run.

The live server exposed and this pass fixed these boundary differences:

- Candidate tool assembly sends configuration without a conversation selector;
  inherited Side assembly selects the conversation without replacing its configuration.
- Assembled input authoring places instructions in an inline developer lead;
  Nexus's raw-only `instructions` field is omitted, including after durable replay.
- One-shot runs explicitly address the Agent selected when opening the conversation.
- Side operations carry the selected workspace through to the application owner.
- Execution projections recognize attention independently of Run status, so active
  Runs waiting for questions or approval do not make unattended clients hang.
- Claim progress coalesces text tails and observes Nexus's 250 ms publication
  cadence; cancellation or a refused publication stops subsequent frames.

Regression coverage exercises real SDK requests, durable admission retries,
selected-workspace Side creation, running-state decisions and paced HTTP progress.
The final conformance run passed 291 tests across 67 files, including Chromium and
WebRTC; both TypeScript checkers and the runtime build passed.

Cleanup removed the temporary Agent, deleted its ten scratch workspaces, revoked
both Agent keys and the temporary Human session, and removed the private test
storage. The original installed runtime still reported ready with its original
Agent identity. The repository-wide `bun run check` passed with 227 existing
warnings and zero errors.
