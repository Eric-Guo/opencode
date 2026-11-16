# Rho behavioral correspondence

Reference: `agents/rho` in Cybros revision
`ef798b1d6828b984a4a02b6dfc8aba34003d7d69`. Paths in the first column are relative
to that directory. Implementation and test paths are relative to this package.
The reference checkout is used for development review only; production and CI
need neither that checkout nor Ruby.

The current reference differs from the previous baseline
`31b82029d75d1ed9626b80739e4caca16671b344` only in Ruby dependency locks and
`rho-env` gem dependencies. Its production source and reference tests are unchanged.

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
| `rho-codemode`: JavaScript binding, frozen catalog, operation receipts and observations                                 | `code.ts`, `orchestration.ts`, `claim-control.ts`                                                              | `code.test.ts`, `executor.test.ts`: native interpreter scheduling, refusal/error distinctions, copied JSON, accepted background ownership, observed-resource forwarding, native execution/data limits and a real native child with one startup slot                                                                                                                                                                                                                         |
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
`packages/nexus-ui`; runtime changes use its existing bridge and management UI.
`rho-runner` has no tracked implementation; its executor behavior belongs to `rho-env`.

## Native OpenCode decisions

- OpenCode owns the managed service, installation/update commands, remote access,
  MCP transports/OAuth, shell, filesystem, snapshots and PTYs. Nexus owns durable
  task operations, approvals and execution settlement. Runner credentials never
  become Human credentials.
- Code Mode uses `@opencode/codemode`, not a separate JavaScript engine. The new
  binding is `urn:opencode:nexus:codemode:1`; frozen old bindings fail before effects.
  Supported syntax, copied values, native tool errors, final-expression results,
  interruption and structural limits follow OpenCode. Full Rho source compatibility
  and its heap/computation limits are intentional differences.
- Output selection preserves Rho's `value()` contract: a later undefined result
  retains the last selection; a defined return or native final expression overrides
  it, including explicit null. Text, native console lines and observed resource
  links keep their invocation order and remain buffered until successful completion.
  Nexus UI task inspection retains structured false, zero and null without adding
  them to the model-visible text. `CodeMode.Success.valueAbsent` distinguishes an
  undefined completion from JSON null; the optional synchronous `onConsole` host
  observer preserves native formatting and is supplied again on snapshot resume.
- Nexus helpers preserve frozen tool restrictions, child model subsets, operation
  receipts, questions, observations, observed resources and background ownership.
  Explicit `nexus.start`/`nexus.wait` handles replace Promise-attached operation keys.
  Ending a program cancels unfinished attached work. Only confirmed transfers release
  ownership. Transport failure and claim loss terminate execution; lost source is
  never reconstructed.
- The experimental executor library supports custom Agent/Runner/tool-provider hosts,
  fixed or captured placement, optional shared admission, HTTP recovery and realtime
  hints. Managed OpenCode uses that same owner. The host owns credentials and SDK
  announcements; this adds no separate application or daemon.
- Extensions and worker extensions receive claim-scoped orchestration capabilities,
  including native Code Mode. The TypeScript extension API, configuration and command
  conventions remain native; no Ruby settings or source are imported.
- ACP can load/resume accessible foreign-agent conversations, submits through addressed
  admission and preserves the recipient's declaration. Code Mode is omitted when the
  runtime or extension does not own it. Persistent local grants require declaration
  ownership; one-time Human approvals retain exact conversation/run ownership.
  Editor filesystem/MCP attachments require this machine's runner. Models are listed
  with Nexus's `text_generation` workload.
- Approval defaults remain Ask. Optional integration defaults remain OpenCode's.
  Development controls remain source-only. UI layout, host document-title control,
  model-management policy and other deployment decisions remain owned by nexus-ui.

## Verification

`bun run test:conformance` requires `OPENCODE_NEXUS_CHROMIUM` pointing at an isolated
Chromium executable. It exercises the production owners with local HTTP/WebSocket,
MCP, OAuth, ACP/T3 child fixtures, real browser, PTY and WebRTC transports.

The native migration has focused regression coverage in `code`, `executor`,
`executor-library`, `editor-policy`, `editor-permissions` and `runtime`. These cover
new/old bindings, native results and diagnostics, frozen catalog restrictions,
explicit handles, cancellation/background ownership, worker-bound capabilities,
provider pool claims, fixed placement, library shutdown and unavailable ACP modes.
CLI/Server adapter tests and the UI bridge's server suite cover integration.

External Telegram and T3 account interoperability remains outside the local gate.
Reference Ruby tests identify contracts; production and CI require neither Ruby nor
the reference checkout. Passing local tests does not imply identical Ruby source,
configuration spellings or language semantics.

The native migration passed 297 runtime conformance tests across 69 files, including
real Chromium and WebRTC; 1,641 shared Code Mode tests; the CLI/Server Nexus adapter
and Protocol identifier tests; and 76 Nexus UI bridge tests. Both runtime TypeScript
checkers and its build passed. Root `bun run check` passed with 227 existing advisory
warnings and zero errors.

A source runtime against local Nexus used `deepseek/deepseek-flash` to discover the
frozen tools, invoke native Code Mode, write and read a scratch file through Human
approval gates, and return `NATIVE_OK`. The live assembled catalog also exercised
pattern-bearing schemas. Temporary workspaces were deleted, the temporary Agent
was removed, its credentials were verified rejected, and private scratch artifacts
were removed. Existing service pairing and credentials were preserved.

## Follow-up review

The second review covered `rho`, `rho-env`, `rho-codemode`, `rho-web-tools`,
`rho-browser`, `rho-mcp`, `rho-acp`, `rho-acp-client`, `rho-ingress-telegram`,
`rho-t3` and `rho-dev`, excluding WebUI. It confirmed and corrected these gaps:

- Tool registration, MCP curation, management commands, executor dispatch and the
  native Code Mode host now share the existing Ajv JSON Schema facility. Pattern,
  conditional and dependent requirements are enforced, additional properties follow
  the declaration, and readable bounded argument errors return before execution.
  Valid conditional schemas are no longer rejected as unrepresentable Effect schemas.
- Expected filesystem refusals (missing files, wrong path kinds, invalid read
  windows, ambiguous edits and invalid text encoding) settle as completed tool-error
  results. Cancellation, transport errors and extension handler failures keep their
  execution-failure semantics. Original files remain intact after refused edits.
- Extensions can declare `environmentRequired: false`, including across worker
  replacement, to opt out of requiring captured placement for non-filesystem tools.
- Operator file captures accept external paths with the existing protected-state
  floor, preserve MIME type using OpenCode's `FSUtil`, and include path/type/size
  metadata beside the uploaded resource link.

Regressions are exercised through the production Code Mode, extension manager,
MCP curation, executor and attachment owners. All 300 runtime conformance tests
across 69 files passed, with real Chromium and WebRTC. Root `bun run check`, the
runtime's official TypeScript checker and build passed; lint retains 227 upstream
advisory warnings and zero errors.

Against development Nexus at `http://localhost:3000`, source executors verified
recoverable read/edit/list/search errors, environment-independent execution,
pattern/dependency/unknown-field refusals, external PNG capture with matching
member-plane bytes and media type, and native Code Mode results. A frozen catalog
with conditional schemas also drove a real Code Mode child tool operation to
completion. All temporary workspaces and Agents were removed; both temporary
credential planes were verified rejected with HTTP 401 and private files deleted.

## Joint runtime and WebUI review

The joint review traced the Rho package contracts through `packages/nexus-ui` and the
managed OpenCode service. New UI chats now leave their title to `ConversationTitles`
instead of storing the first prompt as a manual title. The UI also rereads selected
conversation state every three seconds, matching the reference's HTTP recovery path:
idle metadata and access changes need no transcript event. Navigation, teardown and
authoritative access loss stop those reads, and drafts survive a refusal.

Code Mode's frozen declaration now states the existing output contract explicitly:
returned JSON and `value()` are UI-only; `text()` and `console.log` are model-visible.
It directs the model to print a retained result instead of repeating a successful
effect just to display it. The native Code Mode regression exercises both output
channels for the same completed child tool result, including its error flag and null.
Execution still uses OpenCode Code Mode and Nexus's existing operation/approval owners.

Validation passed: 304 runtime conformance tests with real Chromium/WebRTC, 362 UI
unit tests, 54 browser component tests, both packages' TypeScript checks and builds,
and root `bun run check`. Against Nexus at `http://localhost:3000`, the development UI
and managed service exercised automatic titles, idle access revocation, native Code
Mode/bounded bash calls and approvals, file publication and byte-verified download,
disabled/custom/automatic memory selection, and a real scheduled execution with its
history link. Real terminal output, reload/reattachment and Stop also passed.
Temporary workspaces, schedules and terminal tasks were cleaned up; the managed
service pairing, Agent and default workspace were preserved. Disabled external
integrations remain covered by the conformance suite's local HTTP, RPC and process fixtures.
After the managed service was rebuilt and restarted, a live UI request verified
the updated declaration in the model's durable tool-discovery results. The model
used native Code Mode to run one approved bash effect, printed its observed output,
and retained literal `false` as structured output. Both a scratch execution counter
and the durable task records confirmed exactly one bash execution. The following
sealed model request contained the unpredictable printed token, and the UI answer
returned that token and survived reload. The temporary workspace and scratch files
were removed; pairing, the Agent and the default workspace were preserved. No
additional runtime change was needed for this verification.

Automated regressions cover this contract in `test/runtime.test.ts` (the published
declaration), `test/code.test.ts` (one observed child result printed alongside
structured false, zero or null), and `test/executor.test.ts` (one native child
operation and durable structured false despite duplicate work notifications).
The Nexus UI browser regression covers approval, printed output, sealed-request
inspection and reload without submitting another input or approval.

## Current alignment review

The current inventory retains production TypeScript owners and executable evidence
for all eleven non-WebUI packages listed above. `rho-webui` remains owned by
`packages/nexus-ui`; the empty `rho-runner` directory introduces no additional runtime.
The existing native service, shell, MCP/OAuth, filesystem, snapshot, PTY and approval
owners remain the integration boundaries.

The output regressions now cover selection after later text/console/resource calls,
copied selections, explicit null versus undefined completion, repeated selections,
combined output bounds, cancellation/failure and clean subsequent invocations.
The executor test runs one native child and settles structured false despite
duplicate notifications. The UI bridge and browser tests retain false, zero and null
in task inspection alongside ordered text, across approval and reload.

Validation passed: 309 runtime conformance tests with real Chromium/WebRTC, 1,643
Code Mode tests, 403 UI unit tests and 64 browser component tests. Code Mode's
snapshot round-trip mode passed 1,642 tests with one existing mode-specific skip;
the resume regression verifies observer replacement without replaying old console
lines. Package type checks/builds and root `bun run check` passed. Root lint retains
227 existing advisory warnings and zero errors. One unchanged attachment-menu focus
test failed in the first browser run, then passed three isolated repeats and the
complete browser rerun. External account interoperability remains covered here by
local fixtures; this review did not change live service pairing or account state.
