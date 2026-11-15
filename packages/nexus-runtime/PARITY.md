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
| `rho`: identity, API keys, Human login, configuration, adaptations and conversation titles             | `runtime.ts`, `login.ts`, `settings.ts`, `adaptations.ts`, `conversation-titles.ts`                                     | `runtime.test.ts`, `login.test.ts`, `configuration.test.ts`, `adaptations.test.ts`, `conversation-titles.test.ts`: credential separation, candidate validation, private persistence, field fallback, model spellings, one title attempt and manual-title precedence                                                                          |
| `rho`: Presets, role declarations, Bot policy and switching                                            | `presets.ts`, `bots.ts`, `bot-policy.ts`, `mutation.ts`                                                                 | `presets.test.ts`, `bots.test.ts`, `policy.test.ts`: compare-and-swap, portable definitions, lost committed responses, archived prior roots, external audience restrictions and requester identity                                                                                                                                           |
| `rho`: memory review/policy, Until, instructions and process ownership                                 | `memory-review.ts`, `memory-policy.ts`, `until.ts`, `conventions.ts`, `processes.ts`                                    | `memory-review.test.ts`, `until.test.ts`, `conventions.test.ts`, `processes.test.ts`: captured revisions, private review forks, acceptance graph recovery, bounded instructions and conversation-owned process retirement                                                                                                                    |
| `rho`: extension registration, settings changes and managed packages                                   | `extension-manager.ts`, `configuration.ts`, `packages.ts`, `worker-extension.ts`, `extension-rpc.ts`                    | `extensions.test.ts`, `packages.test.ts`, `worker-extension.test.ts`, `extension-rpc-lifetime.test.ts`: inert disabled code, staged publication, failed-candidate cleanup, retained handler leases, immutable versions, rollback, worker cancellation and remote-reference release                                                           |
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
Human access checks and reply tickets. This correspondence does not expand the
compact UI's documented product constraints.

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
The Nexus UI bridge has its own `server` suite; the CLI and Server adapters have
package-local `nexus.test.ts` suites. CI's runtime conformance job installs Chromium.

These checks establish local behavior. Live account provisioning and live Nexus,
Telegram and T3 deployment interoperability require isolated integration identities;
the automated gate makes no changes to those accounts. They do not establish
byte-for-byte Ruby implementation equivalence or identical CLI/configuration names.
