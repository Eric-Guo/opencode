# Rho behavioral correspondence

Reference: `agents/rho` in Cybros revision
`e2033ac9a1ae12063d86a0c1565dbfd9adc12d72`. Paths in the first column are relative
to that directory. Implementation and test paths are relative to this package.
The reference checkout is used for development review only; production and CI
need neither that checkout nor Ruby.

The reference went through the lean-kernel refactor and the Personal Superagent
reshape since `0d98aa07776db6d38ca5d8bcaf4e10f80c39ed04`: `rho-t3` was removed,
and `rho` gained Channels, Inbox, Routines, Skill drafts and the Superagent Ops
routes. The ten executable non-WebUI packages have TypeScript owners and contract
tests in the [reference contract anchors](#reference-contract-anchors). The latest
review covers the [Personal Superagent alignment](#personal-superagent-alignment).
The [WebUI parity ledger](../nexus-ui/docs/rho-webui-parity.md) tracks
`rho-webui` in `packages/nexus-ui`.

## Personal Superagent alignment

Reviewed November 26, 2026 against Cybros `e2033ac9a` from OpenCode `a82bc392ff8`.
The vendored `@cybros/agent` SDK was rebuilt from `sdks/typescript` at the same
revision (`vendor/cybros-agent-0.1.0-superagent.tgz`), picking up triggers,
thread subscriptions, the outbox with lease-claim and settlement, platform user
cost limits, `remaining_ms`, `ice_servers`, `include_tool_outputs`,
`MemorySelection.mode` and the `tool_name` run filter, and dropping the retired
budget-ledger resources.

| Rho workflow | TypeScript owner | Verified behavior |
| --- | --- | --- |
| `rho` Channels (`channels.rb`) | `src/channels.ts` | Gate outcomes (explicit/observe/auto/filtered), attention policy with quiet hours and daily cap, event rules, outbox enqueue/drain with adapter verdicts, Personal Desk ensure, 8-attempt CAS retry |
| `rho` Inbox (`inbox.rb`) | `src/inbox.ts` | Partition into needs_you/running/snoozed/done with the reference classification order, snooze validation and wake-on-activity, mark-read, complete (marked_read/returned_to_running/archived) |
| `rho` Routines (`routines.rb`) | `src/routines.ts` | Unified time+event list, `act`/`check_in` mapping to `auto`/`passive` wake, check-in prompt prefix |
| `rho` Skill drafts (`skill_drafts.rb`) | `src/skill-drafts.ts` | Propose upsert by (scope, name), limits, approve-into-memory with CAS, dismiss |
| `rho` Superagent Ops routes (`extensions/ops/superagent_routes.rb`, `skill_routes.rb`) | `src/operations.ts`, `src/runtime.ts` (`routine.create`) | `personal_desk`, `inbox.*`, `channels.*`, `subscriptions.*`, `triggers.handback`, `routines.*`, `skills.drafts.*` operations through `application.operation`; time-routine creation through the shared schedule path with desk default, prompt prefix and wake mapping |
| `rho` agent tools (`channel_dispatch`, `propose_skill`) | `src/superagent-tools.ts`, `src/builtins.ts` (`nexus.superagent`) | Agent-served, environment-independent tools in every run declaration; dispatch actions reach the operations layer; failures return tool errors |
| `rho-ingress-telegram` outbox pump | `src/telegram-ingress.ts` | `telegram` adapter registration on activation, 2-second drain pump across workspaces, delivery verdict mapping (sent/dropped channel_gone/failed/uncertain unsettled), `personal` bot key |
| `rho` memory index mode (`speakers.rb`) | `src/speakers.ts`, create paths in `application.ts`, `bots.ts`, `telegram.ts`, `editor.ts` | Every runtime-created conversation binds `memory_context` with `mode: "index"`; explicit full omits the key; speaker binding pinned |
| `rho` personal Bot (`host_followers/bots.rb`) | `src/bots.ts`, `src/telegram-settings.ts`, `src/operations.ts` | Synthetic `personal` target without a profile agent row, owner audience, first-workspace home fallback, desk surface metadata, bot gate skipped, rewind guard refuses only non-personal Bots |
| `rho` memory review cadence (`memory_review.rb`) | `src/memory-review.ts`, `src/memory-review-extension.ts` | `every_turns` default 1 clamped 1–50; a review forks only when `position - after >= every_turns` |
| `rho` preset seeds and prompts (`agent_presets.rb`, `execution_policy.rb`, `run_declaration.rb`, `memory_policy.rb`) | `src/presets.ts`, `src/execution-policy.ts`, `src/memory-policy.ts` | Seeds renamed Personal/Peer with generalized role prompts; attention doctrine, handback guidance and index-mode memory taxonomy in the declaration text |
| `rho` OAuth coalescing (`oauth_login.rb`) | `src/login.ts` | Concurrent verifications of one bearer share a single in-flight profile read; nothing is cached, so revocation is observed on the next request |
| `rho-env` transport hardening (`claim_orchestration.rb`, `deadline_extension.rb`, `task_run.rb`, `claim_realtime.rb`, `webrtc_connection.rb`) | `src/claim-control.ts`, `src/claims.ts`, `src/claim-progress.ts`, `src/runner-inbox.ts`, `src/terminal.ts` | `remaining_ms` anchoring, `operation_ready` wake, observe backoff 250ms→2s, transient control-error retries with clamp semantics, extended park windows, ICE-server inheritance from the realtime projection with relay fallback |
| `rho` terminals/history/schedules wire (`ops/terminals.rb`, `ops/conversation_history.rb`, `ops/schedules.rb`) | `src/terminal-runs.ts`, `src/operations.ts`, `src/jobs.ts`, `src/runtime.ts` | Server-side `tool_name: "terminal"` filter, `include_tool_outputs` forwarding, schedule `wake` authoring with `local_time`/`time_zone`/`starts_at` rule names |

`rho-t3` was removed from the reference; its TypeScript owners (`src/t3*.ts`),
the `nexus.t3` extension, the Nexus UI T3 panel and their tests were removed with
it. The Nexus UI gained the Inbox, Routines, Channels and Knowledge panels, a
Personal Desk action and the memory injection-mode select; its bridge proxies the
new operations with the established workspace and conversation guards. The UI
ledger records the surface behavior.

Runtime conformance passed 499 of 501 tests across 86 files with Chromium, PTY
and WebRTC; the one failure is the pre-existing `sides.test.ts` fork-order race
(two concurrent `openSide` calls), which fails intermittently on the base
revision as well and is unrelated to this review. The Nexus UI passed 452 unit
tests and 126 Chromium component tests, and both packages' type checks and
builds passed, along with the Protocol, Client and CLI type checks, the
regenerated client and root `bun run check` (42/42). New regression suites cover
the four modules (`channels`, `inbox`, `routines`, `skill-drafts`), the
operations surface (`superagent`), the Telegram pump (`telegram-outbox`), the
claim hardening (`claim-control`, `claims`, `claim-progress`, `executor`), the
terminal ICE inheritance (`terminal`), the memory cadence (`memory-review`), the
speakers default (`speakers`), the personal Bot (`bots`, `telegram`,
`operations`) and the OAuth coalescing (`login`).

Intentional substitutions recorded this review: the desk surface metadata key is
`opencode.surface` (the runtime's established metadata namespace) where Ruby
writes `rho.surface`; draft and rule public IDs use `crypto.randomUUID()` rather
than UUIDv7; quiet hours honor the configured `time_zone` where the reference
formats in UTC; and the Telegram pump drains enabled connections only.

### Live verification on localhost

On November 27, 2026 the production modules ran against the development Nexus at
`http://localhost:3000` through a scratch Agent member credential and a private
scratch workspace, driving `Channels`, `Inbox`, `Routines` and `SkillDrafts`
directly over the re-vendored SDK. 21 checks passed:

- The Personal Desk was created with `memory_context.mode == "index"` and
  `opencode.surface: "personal_desk"` metadata, and a second ensure reused it.
- The channel Gate recorded an `observed` outcome with a matching event rule and
  created the trigger without a router; after switching the source to `auto`,
  ingest routed to the desk with `strength: "inferred"` (Nexus outcome `stored`).
- Quiet hours suppressed a proactive `result` (`suppressed_reason:
  "quiet_hours"`) while a plain `answer` queued; the outbox drain settled `sent`
  and left an `uncertain` message unsettled.
- The Inbox listed the desk, snoozed it `indefinite`, and `complete` returned
  `marked_read`. Routines listed the event rule and the saved attention policy.
- Skill drafts proposed, listed and removed. A daily schedule was created with
  `wake: "passive"` through the real schedules endpoint.

The scratch workspaces, conversations, memory collections, store entries,
speakers and the Agent were deleted and the member credential revoked; the
elected service was not restarted and kept its original pairing. The installed
managed service predates these source changes and needs a rebuild to ship them.

## Project Presets and development environment commands

Reviewed November 24, 2026 from OpenCode `6a8077b2f58` and Nexus UI `27fef8c0`.
The Rho changes from `79ff4f2da` to `0d98aa077` affect two READMEs.

- The experimental Nexus management command `preset.import-project` uses the active runner root.
  It visits immediate Markdown and JSON files in sorted order under `.agents/agents`, then
  `.claude/agents`. Its optional `names` list matches Preset names. Each scan imports the first
  valid document for each selected name and returns `imported`, `skipped` paths with reasons,
  and `missing` requested names. A missing root yields an empty scan. A subsequent import creates
  new catalog identities. OpenCode publishes the accepted batch in one catalog write.
- The development CLI checks the MCP file is a JSON array and requires a port endpoint and token
  before dispatch. The CLI regression counts zero target lookups and zero binds for malformed input.
  The `environments` command prints an explicit empty listing and reports each mounted server's
  public name, state and fault. JSON callers get structured server rows alongside tool names
  and validation issues. Literal `--mcp '[]'` closes mounts and `port ID --clear` detaches the port.
- On Nexus at port 3000, the source-built OpenCode service imported from an isolated project,
  reported a malformed file, accepted a later valid definition of the same name and reported a
  missing requested name. Both exported formats passed through the live catalog with the Unicode
  prompt, trailing newline, inherited tools and explicit empty lists intact. The source development
  CLI displayed a connected zero-tool HTTP MCP peer alongside a failed SSE mount and its reason.
  Rejected commands preserved the mounts. Both detach commands succeeded. The installed service
  supplied the comparison export at UI port 4779. The disposable catalogs, workspaces and credentials
  were retired and the installed service remained ready.

The [reference contract anchors](#reference-contract-anchors) passed 754 Ruby cases across all eleven
packages, including the shared runner test definitions. The production TypeScript owners passed
460 conformance cases across 79 files using Chromium, PTYs and WebRTC. The Linux-only filename-byte
case skipped on macOS. The runs cover application admission and recovery, runner execution and
terminals, Code Mode, MCP, browser control, web fetch, both ACP directions, Telegram, T3 and the
development terminal. ACP, Telegram, T3 and external web-provider protocol cases used local peers.
The runtime build and package, both runtime type checks, affected CLI and Server tests, protocol
identifiers and root `bun run check` passed. The management change required regenerating the
OpenCode client and OpenAPI document. The existing Cybros TypeScript SDK handled the live workflows.

## Managed skills and ACP session setup

Reviewed November 24, 2026 against Cybros `79ff4f2da` in the OpenCode working tree based on `fef04675d02`.

- The `rho` Ops skill routes and `rho-dev/test/dev_skills_test.rb` map to `src/operation-skills.ts` and the
  development terminal. Show, push and remove read the selected scope's default collection. Only a
  `memory_not_found` read permits creation. The HTTP fixture observes zero writes on a workspace refusal
  or missing removal and checks the document ID and lock version on mutation. Text output reports the
  saved path and byte count, prints the body with its original trailing newline, and is silent on removal.
- The `rho-env/test/skills_test.rb` discovery case maps to `src/skills.ts`. A nested-only directory, an
  empty directory, a loose file and a hidden entry produce no reported skills or diagnostics.
  Malformed documents and duplicate names remain visible in the runner's diagnostics.
- The `rho-acp` methods suite maps to `src/editor.ts`. History replay finishes before the load response.
  New, load and resume return before the skill roster arrives. A blocked admission reaches the editor
  as invalid parameters with the kernel reason. ACP and one-shot CLI tests both exercise a complete
  `input_blocked` event with the reason `unknown_model`.

On Nexus at `localhost:3000`, the source development terminal and built runtime created and replaced a
workspace skill in a private workspace. A six-byte body kept its trailing newline. Replacement retained
the ID and advanced the version. Removal printed zero bytes and a subsequent read returned
`memory_not_found`. An ACP peer resumed a conversation while the catalog was pending, then received the
workspace skill. An input naming an unavailable provider reached the peer as `-32602` with
`unknown_provider`. The installed service supplied the original pairing. After cleanup it reported ready
in its original workspace and the deleted workspace returned HTTP 404.

Runtime conformance passed 458 tests with Chromium, PTY and WebRTC. The Linux-only filename case
skipped on macOS. Selected Ruby suites passed 386 cases across all eleven runtime packages, covering
Ops, runner claims and file edits, Code Mode, MCP curation and refresh, browser lifecycle, web rendering,
ACP and delegation, Telegram recovery, T3 work and development commands. The [WebUI review](../nexus-ui/docs/rho-webui-parity.md#memory-binding-names-and-collection-identity)
records the Human-facing checks.

## Personal instructions and delegated work

Reviewed November 24, 2026 against Cybros `79ff4f2da` from OpenCode `27b1b2b39e4`.

- `rho/test/persona_commands_test.rb` maps to the production `nexus persona`
  command, `src/persona.ts` and `NexusRuntime.manage`. The source CLI and source
  OpenCode server ran against a disposable Rails Nexus installation. A Human
  signed in through the browser, wrote instructions from a file and stdin, read
  them back and reset the document. The local runtime had no active Agent.
  `test/persona.test.ts` covers the exact 64 KiB boundary, invalid UTF-8, a BOM,
  line endings, missing documents and unrelated 404s.
- `rho-t3/test/work_test.rb` and `session_test.rb` map to `src/t3.ts`.
  An uncertain Nexus task releases ownership. Continuing or forgetting still
  requires settled native work, including its child agents. Stop accepts a
  missing or already-terminal owner. A not-adjudicable cancellation requires
  reading the saved owner's status. `test/t3.test.ts` exercises these decisions
  through the registered tools with local Nexus and T3 protocol fixtures.
- `rho/test/extensions/ops_terminals_test.rb` and the `rho-env` terminal suites
  map to `src/operations.ts`, `src/terminal-runs.ts` and `src/terminal.ts`.
  The `terminal.list` operation includes settled standalone terminals in its
  history. The UI uses the same query with the viewing Human's credential and
  filters settled tasks from its attach picker.
  The UI opened a shell on the installed runner, reattached after reload, read a
  variable from the same shell and stopped it. The private workspace returned
  HTTP 404 after cleanup. The [UI review](../nexus-ui/docs/rho-webui-parity.md#terminal-recovery-and-structured-questions)
  covers discovery, creation retries and output replay.

Runtime conformance passed 456 cases with Chromium, PTY and WebRTC. One
Linux-only filename case skipped on macOS. The selected Ruby suites passed
141 cases across all eleven executable packages. They covered Ops, terminal
streaming, Code Mode claims, MCP curation, web commands, idle browser sessions,
ACP permissions and delegation policy, Telegram recovery, T3 and development
execution commands. The Rho WebUI seat and terminal JavaScript suites passed
20 and 33 cases respectively.

## Scheduled jobs and operator web fetch

On November 24, 2026, the installed CLI and elected service were checked against
Nexus on `localhost:3000` from OpenCode `f774b3dc494`. In a private workspace,
the CLI listed, created, read, edited, paused, resumed, ran and canceled a
recurring job. Its prompt-only edit retained the model selection, tool list,
approval and rule. A one-time job fired on the Nexus clock and had no next run
afterward. Across those jobs and a concurrent UI/CLI edit, the three child
executions each completed once. The deleted workspace returned HTTP 404 and the
service reported ready on its original workspace.

With isolated local settings, the installed `web-fetch` command returned all
139,999 text bytes and a six-byte binary. A 404 exited 1 with empty stdout.
The [UI verification](../nexus-ui/docs/rho-webui-parity.md#live-scheduled-results)
covers delivery and conflicting edits through the Human bridge.

Importing `@opencode/nexus-runtime` alone in a fresh Bun process also exposed
a Core initialization cycle between session working-directory metadata, file
access and permissions. Loading file access inside `SessionCwd.locate` lets
the runtime import and the standalone Server Nexus test complete. All 51 focused
working-directory and file-access cases passed. The runtime conformance suite
passed 454 cases with one Linux-only skip on macOS. Selected Ruby suites passed
108 cases across the eleven executable Rho packages.

Reviewed November 24, 2026 against Cybros `7a8243168` from OpenCode `dfe362962c5`.
The [reference anchors](#reference-contract-anchors) identify the TypeScript implementation
and local tests for each of the eleven executable packages.

- `rho` Ops and the installed CLI share conversation job behavior with
  `src/runtime.ts` and `src/jobs.ts`. An ordinary job captures the selected model,
  its explicit or default routing intent, fallbacks, available tools and runner
  contexts. A conversation with a captured declaration keeps its model controls
  unless the caller overrides them. Updates send the supplied fields and lock version.
  The SDK supports clearing a name and disabling reasoning independently.
- `rho-ingress-telegram` uses the same schedule parser through
  `src/telegram-ingress.ts`. The Bot path retains its own author, captured model
  selection, requester, delivery target and retry key.
- `rho-web-tools` has an offline operator entry point in `src/web.ts` and the
  production CLI. It uses the configured Web reader and the same fetch and
  rendering code as the runner. A local HTTP peer served 120,000 bytes of text
  and a six-byte binary verbatim. A 404 produced zero stdout bytes and exit 1.

The development CLI created, edited, paused, resumed, ran and canceled a job in a
private workspace on `localhost:3000`. The stored schedule retained the opening
model pin, runner context, empty tool and fallback lists, and explicit reasoning
disablement after a prompt-only edit. Nexus reported the child execution as completed.
The scratch workspace returned HTTP 404 after deletion. Its Agent and keys were retired
and the elected service reported ready on its original pairing.
The [WebUI review](../nexus-ui/docs/rho-webui-parity.md#scheduled-job-drafts-and-detail-links)
covers the Human view of the same workflow.

Runtime conformance passed 453 cases across 78 files with Chromium, PTY and WebRTC.
The Linux-only filename case skipped on macOS. The selected Ruby reference run covered
108 cases across all eleven owners. In Cybros `79ff4f2da`, the Rho Ops job and execution fixtures include
the required `wake: "auto"` field. Running `bundle exec ruby -Itest test/extensions/ops_schedules_test.rb`
from `agents/rho/rho` passed all four tests and 58 assertions using those fixtures.
The TypeScript SDK check, regenerated client, CLI and Server Nexus tests, runtime build
and pack, and root `bun run check` passed.

## Standalone tool settlement

Reviewed November 24, 2026 from OpenCode `dddbd23cafa` and Nexus UI `57d366e`.
Cybros `7a8243168` still has the verified `agents/rho` tree `7ea67f07b`.

Against a controlled Nexus peer, Rho's `call_tool RUNNER code` went through the
development CLI, Ops daemon, executor and claim bridge. Its raw tool step had an
empty frozen tool catalog. The executor reported `unsupported_binding` before
evaluating `return 0`, and the CLI printed the failed task and exited 1.

With a one-second step timeout and a peer that settled the task after 7.5 seconds,
Rho waited for the terminal task, stopped its run, and printed the result.
OpenCode stopped the run at six seconds and printed no task. The relay now
waits for Nexus to settle the task under the requested step timeout.
The regression in `test/dev.test.ts` checks the output, exit status and stop order for `timed_out`,
`failed` and `completed`, including the original runner placement and author rules.

On `localhost:3000`, a scratch runner announced `read` and left a one-second
request unclaimed in a private workspace. The last poll before settlement still
showed `dispatched` at 28.9 seconds. At 29.5 seconds the source runtime read
`timed_out` with `tool_timeout` and sent one stop. The terminal printed the task
and exited 1.
After the runner started, a read returned the scratch file marker, matched the
stored task in JSON and exited 0 with zero stops. Standalone `code` returned
`tool_failed` with `unsupported_binding` and exited 1. The deleted workspace
returned HTTP 404. The runner and both keys were revoked, the scratch Agent was
removed, and the elected service reported ready on its original pairing.

The affected Rho and Ruby SDK suites passed 135 cases. Runtime conformance passed
451 tests across 77 files with Chromium, PTY and WebRTC. The Linux-only filename
case skipped on macOS. The three settlement cases each passed ten consecutive
runs. Both runtime type checks, the build, the CLI and Server Nexus tests, the
Protocol identifier test and the root `bun run check` passed.

## Recorded changes and published outputs

Reviewed November 23, 2026 from OpenCode `58261aaef0c` and Nexus UI
`cfb68a7221`. Cybros `7a8243168` has the same `agents/rho` tree
(`7ea67f07b`) as the previous baseline, `4053db620`.

| Rho workflow | TypeScript owner | Verified behavior |
| --- | --- | --- |
| `rho/lib/rho/run_changes.rb`, `rho-env` checkpoints | `src/recorded-history.ts` reads durable task results | Review takes the newest capture per original runner and root, up to the deliverable’s completion or the run’s completion when the deliverable has no timestamp. An empty later capture clears a reverted diff. Older OpenCode results with only step patches remain readable. Restore addresses the original local task. |
| `rho` published artifacts | `src/published-artifacts.ts`, shared by ingress and the UI bridge | Explicit file publications and generated images are resolved under the reader’s credential. Child callbacks follow the accepted variant, including after another becomes active. Activity retains incidental captures. |
| `rho-dev task` and `call_tool` | `dev/terminal.ts` | Text mode prints the task outcome, approval, tool input, structured output and captured blocks once. Resource links include available MIME type, byte count and fetchable ID. JSON retains the complete SDK result. |

The [owner mapping](#application-and-executor) and [reference test table](#reference-contract-anchors)
cover all eleven executable runtime packages. The selected Ruby suites passed 143 tests
across all eleven, including Ops review and publications, checkpoint storage, the Code Mode
claim bridge, web rendering, browser tools, MCP conversations, ACP replay and delegation,
Telegram delivery, T3 work and development CLI artifacts. OpenCode conformance passed
449 tests across 77 files with Chromium, PTY and WebRTC enabled. The Linux-only filename
test skipped on macOS. Both runtime type checks, the runtime build and the root check passed.

Port 3000 was unavailable during this review. An isolated Nexus server with temporary
PostgreSQL databases served real HTTP reads using a Human credential and seeded history.
The development terminal’s text and JSON agreed on a recorded write. The UI bridge read
two original runners without a local runner, rejected a capture completed in the following second,
and read the same patches through a fork. Nexus exposes task completion at whole-second
precision, so a task tied with the deliverable remains eligible, as in Rho. Capture metadata
retains microseconds for choosing between eligible snapshots. The [UI review](../nexus-ui/docs/rho-webui-parity.md#answer-files-and-recorded-changes)
covers publication, byte downloads and inherited history.

### Verification on localhost

On November 23, 2026 the paired service was available at `localhost:3000`.
The source runtime at `b4cf5220da3` and the working UI used a private workspace.
A model-driven write and publication ran on the paired runner after Human approval.
The source development terminal read its approval and metadata, published a file through
`call_tool`, and returned the same upload ID, MIME type and byte count in text and JSON.
Three conversation Code Mode tasks printed their markers once and retained structured
zero, false and null. A standalone `call_tool code` without a frozen Code Mode binding
returned `unsupported_binding` and exit status 1.

A `bash` task running only `pwd` retained the run’s baseline. A later write produced
the first patch. The restore action was missing because the checkpoint task had no patch. The reader
now retains that task independently of its patch. The source UI restored the same
saved run on disk. A separate two-write run had one retained baseline and restored
both files. Seeded history on the live server exercised original runners, capture order,
cutoffs, reverted and legacy changes, and inherited review. The temporary workspace
returned HTTP 404 to both the Human and Agent after deletion.

The reference rerun passed 143 Ruby cases. The Git timeout test twice missed its
temporary PID file under Bundler's launcher. Running the complete checkpoint suite
directly with Ruby passed all 33 cases, including that timeout.

## Standalone inference and follower inspection

Reviewed November 23, 2026 against Cybros `4053db620` from OpenCode
`f6fe5642d8d`. The [reference contract table](#reference-contract-anchors)
identifies the TypeScript owners for all eleven executable runtime packages.

| Rho entry point | OpenCode behavior | Regression coverage |
| --- | --- | --- |
| `rho` Ops inference requests and `InferenceRequestRun` | Four commands on `experimental.nexus.manage` create, list and change subscriptions. The paired Agent submits the caller's key, workload, model controls, uploads and billing subject. Replays adopt the same request within its workspace. Connection replacement drains admitted creates and retires the old followers. | `test/inference.test.ts`, `test/runtime.test.ts` |
| `rho` inference event and result followers | A shared SDK socket carries full or lifecycle subscriptions. Switching replays the saved cursor. Rollback clears the preview. A terminal event wakes an HTTP read, and independent polling recovers the terminal resource when the wake is lost or event history has expired. | `test/inference.test.ts`, SDK `test/runtime.mjs` |
| `rho-dev` followers and providers | The development terminal shows run status, attention, Until checks, failure reason and Side parent. Provider output shows credentials, enablement, configuration, model count and the end of temporary unavailability. Both commands retain JSON output. | `test/dev-worker.test.ts`, `test/until.test.ts` |

An isolated process loaded the built runtime and used the paired Agent against
Nexus at `localhost:3000`. Creating and replaying a text request on
`deepseek/deepseek-flash` returned the same ID,
`01a208ab-716c-74a4-becd-d057e82809f7`, and one follower.
All three full/lifecycle switches reported a change. The completed snapshot
at sequence 4 matched the full resource fetched from Nexus and contained
`READY`. Deleting the request and its private workspace was verified by
reading each back and receiving HTTP 404. The development terminal's text
and JSON provider output also agreed on all ten lanes returned by the
installed service.

The selected Rho reference suites passed 573 cases across the eleven packages,
including 27 history-route cases. Runtime conformance passed 448 tests with
Chromium, PTY and WebRTC enabled. The Linux-only filename-byte case skipped
on macOS. Core MCP and Integration passed 135 tests, Code Mode passed 325,
and the SDK check, regenerated clients, runtime build and root `bun run check`
passed.
The [WebUI review](../nexus-ui/docs/rho-webui-parity.md#conversation-history)
covers the separate UI implementation and its Chromium regression.

## Scheduled executions and adaptation inspection

Reviewed November 23, 2026 from OpenCode `26db46cf45b` against Cybros
`4053db620`. Since the prior review, the Rho changes are Ruby lockfile
updates for `rho`, `rho-browser` and `rho-dev`. The [package mapping](#application-and-executor)
and [reference tests](#reference-contract-anchors) identify the TypeScript
owners and executable contracts for all eleven runtime packages.

| Rho workflow | TypeScript behavior | Verification |
| --- | --- | --- |
| Telegram scheduled jobs, `schedule_tracking.rb` and `schedule_workflow.rb` | Polling saves each page of occurrences with its cursor. A pending input keeps its page eligible for another poll. Reading `/job history` binds the listed task IDs to their original requester and child conversation before replying. An explicit Stop or Steer can address the child, and a bare Stop still selects foreground work. A parent report and a separately addressed child result retain their destinations. | `test/telegram.test.ts` interrupts a poll after 100 occurrences, restarts it, and exercises history, ownership, cancellation and steering. `test/telegram-workers.test.ts` exercises a parent with only a scheduled job. |
| Development CLI, `rho-dev/lib/rho/dev/conversation.rb` | `adaptations --model PROVIDER/REFERENCE` shows the selected row, match, tool styles, description recuts, summarizer digest and hint IDs. A different boot row is identified. With the service offline, the CLI reads the saved model and local adaptation files. Connected inspection includes the model catalog response or its read error. | `test/adaptations.test.ts`, `test/dev.test.ts` and `test/runtime.test.ts` exercise selection, a separate offline CLI process, and the connected management operation. |

The source Telegram ingress used a scratch Bot on Nexus at `localhost:3000`
with a loopback Telegram transport. After restarting ingress, `/job history`
returned the input ID for job `01a207c2-5936-7409-9e90-a3d32b454fa7`.
Explicit Stop canceled that input in its child conversation. The stored cursor
matched the execution page returned by Nexus. The Bot and workspace were removed.
A separate admitted occurrence reached running during observation. Verification
of a completed parent report used a controlled callback.

Runtime conformance passed 444 tests on macOS. The Linux-only byte-preserving
filename case skipped. Both runtime type checks, the package build and root
`bun run check` passed. The Core MCP and Integration suites passed 224 tests.
The CLI and Server Nexus adapters passed three tests, and the Protocol
identifier check passed. Selected Rho suites passed 172 tests across the eleven
runtime packages. The [UI review](../nexus-ui/docs/rho-webui-parity.md#workspace-schedules)
records the workspace schedule and Chromium checks.

## Editor MCP and workspace run listing

Reviewed November 23, 2026 from OpenCode `9fc413cb08b` and Cybros
`48ff47738`. The WebUI review used the separate Nexus UI checkout at
`cf69cafab`.

| Rho entry point | OpenCode execution path | Behavior exercised |
| --- | --- | --- |
| `rho` daemon and environment routes | `runtime.ts`, `application.ts`, `admission.ts`, `turn-lifecycle.ts` | Agent connection, admission replay, captured declarations and held execution recovery |
| `rho-env` runner and tool handlers | `runner-inbox.ts`, `runner.ts`, `environments.ts`, `terminal.ts` | Claim placement, file reads, approval and PTY ownership |
| `rho-codemode` code and claim bridge | `nexus.codemode` → `code.ts` | Calls from an accepted claim through OpenCode Code Mode and result delivery |
| `rho-mcp` conversation registrar | `nexus.mcp` → `mcp-session.ts`, `mcp-sessions.ts`, `mcp.ts` | Real stdio peers, catalog curation, anchor-scoped calls and mount retirement |
| `rho-browser` tools and sessions | `nexus.browser` → `browser.ts`, `browser-session.ts` | Tab ownership, navigation, cancellation and recovery in isolated Chromium |
| `rho-web-tools` fetch and render | `web.ts` | Redirect handling, response rendering and truncation |
| `rho-acp` editor sessions | CLI `nexus acp` → `editor.ts`, runtime registrar | New, load and resume on a remote runner, editor disconnect and declined attachments |
| `rho-acp-client` delegation | `acp.ts`, `acp-child.ts` | Child tool results, cancellation and reuse |
| `rho-ingress-telegram` access and delivery | `telegram-ingress.ts`, `telegram-transport.ts`, `telegram-workers.ts` | Sender ownership, durable delivery and worker results with a Telegram protocol fixture |
| `rho-t3` work and stop handlers | `t3.ts`, `t3-transport.ts` | Work ownership, cancellation and resumption with a T3 protocol fixture |
| `rho-dev` run routes and CLI | `dev/cli.ts` → `dev/extension.ts`, `operations.ts`, `dev/streams.ts` | Workspace-visible runs, status and attention filters, pagination and local observation |

The selected Rho reference suites passed 328 cases across these eleven
packages. OpenCode conformance passed 440 tests across 76 files on macOS.
The Linux-only byte-preserving filename test skipped. Core MCP and Integration
passed 138 tests, the CLI and Server Nexus adapters passed three, and the
Protocol identifier check passed. Both runtime type checks, its build and
root `bun run check` passed.

### Live source checks

An isolated managed service connected to `http://localhost:3000` using two
scratch Agents, a private machine runner and a scratch workspace. The real
ACP CLI opened an owned conversation with the MCP extension disabled and
returned a session ID with the reason in `_meta["opencode.mcp.issues"]`. Rho
prints this diagnostic on stderr. After enablement, resume mounted a stdio
peer on the Agent. The remote runner kept `/remote/review/project` and its
additional directory. The two executor contexts carried the same conversation
anchor.

The accepted prompt in conversation `01a205eb-a4d0-742b-912b-fdd555a3e633`
produced run `01a205eb-ade8-73d4-849a-6073bd66c53d`. Task `r2t0` completed
`mcp__review__reportcwd` and returned the Agent's configured local working
directory. The model received the result. Session close removed the callable
tool. Loading the conversation in a new editor mounted it again, and closing
editor stdin retired it on process exit. The sealed model request also
confirmed the [kernel tool selection saved in Chromium](../nexus-ui/docs/rho-webui-parity.md#new-conversation-defaults).

The source development CLI listed two pending standalone runs created by
different Agents in the same workspace. Attaching one changed only its
follow marker. OpenCode's JSON output retains the SDK page and cursor.
The worker regression also distinguishes a known conversation from an
observed run and checks the next filtered page.

Cleanup confirmed the workspace reached `deleted`, both Agents reached
`removed`, and the private runner and all five scratch credentials were
revoked. The isolated source service and UI server were stopped.

## Runner placement and model selection

This review used OpenCode `71cb4b89d5e` and Cybros `48ff47738`.
The [package mapping](#application-and-executor) identifies the TypeScript
owners for all eleven executable non-WebUI packages.

| Workflow | Behavior | TypeScript checks |
| --- | --- | --- |
| Development CLI and one-shot prompts | Opening with a directory validates it for the selected runner before creating the conversation. Local paths resolve on disk. A remote runner accepts absolute paths that exist only on its host. The stored root, additional directories and conversation anchor travel with the accepted input and its Until check. Project instructions come from the local runner only when it owns a filesystem context. | `test/dev.test.ts`, `test/environments.test.ts`, `test/conventions.test.ts`, `test/run.test.ts` |
| ACP editor | New sessions pass the editor's root set to the same open operation. Load and resume bind the requested root set to the conversation's current runner. Editor filesystem capabilities require local runner placement. The later [editor MCP review](#editor-mcp-and-workspace-run-listing) covers agent-owned mounts on remote-root sessions. Relative paths and root sets over 4 KiB are rejected at the ACP boundary. | `test/editor-policy.test.ts`, `test/editor.test.ts` |
| Input model | For the runtime's Agent and Bots, an omitted model inherits the last accepted explicit choice. A string pins a route, including the current default. An explicit null clears the pin. Preparing a request reserves its selection for retries, and it affects subsequent inputs upon acceptance. | `test/application.test.ts`, `test/bots.test.ts`, `test/dev.test.ts` |

The development CLI opened a scratch conversation on the live Nexus server at
`localhost:3000`. The source UI bridge prepared, submitted and replayed three
Human inputs to conversation `01a20220-0820-7a24-a37d-69df229a08bd`. Each
replay returned its original input ID. The first input pinned a model, the
second cleared it and the third inherited the Preset default. All three
captured the root, additional directory and anchor. A separate standalone run
`01a20220-28d7-73cc-8015-e9e4ef209a2b` completed after its held task was
answered. The scratch Agent and workspace were removed and credentials revoked.
Remote runner paths were exercised with an isolated ACP peer and runtime fixtures.

Runtime conformance passed 436 tests. The Linux-only filename test was skipped
on macOS. Both runtime type checks, the production build, the CLI and Server
adapter tests, the Protocol identifier test and root `bun run check` passed.
The reference suites passed 265 Ruby tests across all eleven runtime packages,
including 19 ACP environment tests. The [UI verification](../nexus-ui/docs/rho-webui-parity.md#composer-drafts-and-model-selection)
covers the browser controls and signed retries.

## Conversation streams and browser references

This review used OpenCode `ab832ab28c6` and Cybros `48ff47738`. The Rho and
TypeScript SDK sources match the previous reference pin. The [package mapping](#application-and-executor)
and [reference tests](#reference-contract-anchors) cover all eleven runtime packages.

| Workflow | Observed behavior | TypeScript checks |
| --- | --- | --- |
| One-shot prompts and ACP | A direct reply streams on the conversation channel under its turn and variant. A loop-backed reply uses the same channel and carries a run ID. Other executions cannot contribute text or tool progress. Settling a reply emits its remaining text once. | `test/run.test.ts`, `test/editor.test.ts` |
| Development watch and follow | Standalone runs subscribe to run feeds. Conversation observers subscribe to conversation feeds, follow the streaming variant during regeneration and reconcile the final answer over HTTP. Scheduled inputs include their ID and delivery time. | `test/dev.test.ts`, `test/dev-worker.test.ts` |
| Isolated Chromium | An element reference from a sibling or a replaced tab cannot select, click or type into the current page. Fresh snapshot references work on the replacement. | `test/browser.test.ts` |

**Live Nexus.** A source one-shot prompt and development observer received live
deltas for a direct reply with no run ID through the Human connection at
`localhost:3000`. The prompt returned one final answer, which `watch` also
recovered after completion. A second conversation with an authored trailing
step emitted run-correlated transcript frames. A standalone run published task
events and completed after its structured question was resolved. Each scratch
workspace returned HTTP 404 after deletion. The browser and ACP checks used
isolated test peers. The [UI ledger](../nexus-ui/docs/rho-webui-parity.md#new-chat-runner-selection)
records the runner-selection checks.

**Verification.** Runtime conformance passed 434 tests on macOS with one
Linux-only filename test skipped. Both runtime type checks, the build, the
CLI and Server Nexus adapter tests, the Protocol identifier test and root
`bun run check` passed. The reference suites passed 177 Ruby tests across
all eleven packages.

## MCP catalog previews and development streams

The review used OpenCode `113f542b546` and Cybros `c0ebf861e`. The
[package mapping](#application-and-executor) identifies the TypeScript entry
points for all eleven runtime packages. The source-only `rho-dev` commands
use the same Nexus application and realtime client as the managed service.

- **MCP.** An otherwise valid server with no `tools` field stays down.
  An explicit `mcp.probe` opens a temporary native OpenCode MCP connection
  and reports eligible tools, declaration sizes and reasons for skips.
  After the probe, the connection is closed and the published catalog and
  settings are unchanged. Explicit empty or malformed allowlists open zero
  connections. `test/mcp-session.test.ts` checks these cases against an HTTP peer.
- **Development CLI.** `watch` and `follow` mark discarded visible output
  once, including when a slow reader misses the reset and the new answer
  shares the discarded prefix. Reasoning is opt-in. A completed foreground
  turn ends observation even while its run continues, and a timed-out turn
  returns a failure exit status. `watch` identifies the remaining background
  tasks or how to continue a held run. `test/dev.test.ts` exercises both
  commands and the shared WebSocket follower.

**Live Nexus.** The source CLI and follower observed a standalone run through
the configured Human connection to `localhost:3000`. A private workspace's
structured question was resolved through the SDK. Both commands reported
the completed task and exited zero. The scratch workspaces returned HTTP 404
after cleanup. Retry resets, timeouts and concurrent background work were
checked with controlled frames.

**Checks.** The runtime conformance suite passed 429 tests on macOS with one
Linux-only filename test skipped. Both runtime type checks, the runtime
build, the CLI and Server Nexus adapter tests, the Protocol identifier test
and root `bun run check` passed. Selected Ruby tests exercised all eleven
packages, including MCP curation and commands, development streaming and
watch, ACP replay and delegation, executor tools, Code Mode, browser sessions,
web rendering, Telegram input batching, T3 work and the application core.
The [UI verification](../nexus-ui/docs/rho-webui-parity.md#model-context-recovery-and-child-navigation)
covers task recovery and child navigation.

## Delegation, browser snapshots and conversation controls

The `agents/rho` and `sdks/typescript` trees at `c0ebf861e` match the previous
pin, `3ee723203`. The runtime conformance suite exercised the TypeScript
entry points in the [package mapping](#application-and-executor) on November 22, 2026.

| Workflow | Observable behavior | OpenCode regression |
| --- | --- | --- |
| `rho-acp-client` delegation | A live child can refuse a prompt and accept the next one. An exited child returns its partial answer, redacted stderr and exit status even when the answer needs truncation. Continuing its handle reports the exit. Omitting the handle starts a fresh session. | `test/acp.test.ts` through the delegation tool and a real ACP child process |
| `rho-browser` snapshot | The structured URL and title fit 512 and 256 UTF-8 bytes including the omission marker. The isolated Chromium renderer uses the same values in its text header. The surviving button ref remains actionable. | `test/browser.test.ts` and `test/desktop-browser.test.ts` through the Chromium and desktop adapters |
| `rho-env` Git review | When the 32 KiB Git output budget ends inside a tracked path, the file list contains only complete status/path pairs and reports truncation. | `test/git-review.test.ts` using a real Git index with 180 tracked deletions |
| `rho-dev` conversation controls | Cost reads report the exact ledger decimal and unit, completeness, limit and reached state. Setting or clearing the limit leaves retry to the caller. Invalid arity sends zero requests. Side followers include their readable fork source. | `test/dev.test.ts` and `test/dev-worker.test.ts` through the CLI and extension worker |
| `rho` application operation | A successful Nexus deletion with HTTP 204 returns JSON null through the management operation. | `test/runtime.test.ts` through `NexusRuntime.manage` |

**Live Nexus.** The source development CLI used the paired OpenCode service
at `8d668a13f84` to read, set and clear a scratch conversation's limit at
`localhost:3000`. The Human-facing UI bridge read back `2.012345` and then
a cleared limit. The conversation stayed idle with zero model requests. On
deletion the installed build reported a JSON validation error after Nexus had
committed the deletion. The runtime regression covers that empty-response
conversion in source. A second scratch conversation repeated the cost and UI
checks and was deleted through the Human SDK. Both scratch IDs returned 404
and the paired service reported ready.

**Checks.** Runtime conformance passed 427 tests on macOS, with one Linux-only
filename test skipped. Both runtime type checks, the runtime build, the CLI and
Server Nexus adapter tests, the Protocol identifier test and root `bun run check`
passed. The reference ACP child, browser snapshot, Git review and development
conversation suites passed 50 Ruby tests. The UI has its own
[usage and recovery verification](../nexus-ui/docs/rho-webui-parity.md#usage-and-cost-limit-recovery).

## Approvals, task inspection and editor replay

The Rho and TypeScript SDK trees at `3ee723203` match the previous pin,
`42a2ecb2c`. The [reference tests](#reference-contract-anchors) and
[production entry points](#preset-tool-selection-acp-capture-and-t3-setup)
cover all eleven runtime packages. The workflow tables below pair those
entry points with their local regression suites.

| Workflow and Rho reference | OpenCode entry point | Regression |
| --- | --- | --- |
| Editor call, permission and history, `rho-acp/test/acp/{mapping,permissions,reference_replay}_test.rb` | Nexus ACP `session/load`, `session/prompt` and `session/request_permission` through `src/editor.ts` | `editor.test.ts` replays two connections offering `write`, an error preview, a local write and a multi-edit. `editor-permissions.test.ts` compares the first tool notification with a permission discovered before any call frame. `editor-replay.test.ts` exercises the 50-turn history page limit. |
| Account selection and reporting, `rho-mcp/test/curation_test.rb` and `rho-dev/test/dev_commands/{execution,stream}_test.rb` | Preset selection, then the source dev CLI's `task`, `watch` and `follow` commands | `policy.test.ts` distinguishes connections with the same remote tool. `dev.test.ts` reads the captured callable, connection, account and remote tool from task detail and run updates. |
| Telegram decisions, `rho-ingress-telegram/lib/rho/ingress-telegram/bridge.rb` and `test/bridge_test.rb` | `TelegramIngress.ingest` and `tick` recover an Input and resolve its held task | `telegram.test.ts` exercises a reused task key after fallback, restart, missing labels, and the 2,000/2,001-code-point boundary with emoji. Buttons and text commands reread the persisted decision. Oversized or structured questions direct the operator to OpenCode. |

**Development Nexus.** An isolated source OpenCode service paired a scratch Agent
to `localhost:3000`. Two connections exposed `web_fetch`, one without an account
label. The source dev CLI inspected both held tasks. Renaming the first account
revealed that the Nexus task projection looked up its current label. Nexus now
stores the two labels when accepting each task (Cybros commit `ceae14715`). A new held task retained
`Research` after the connection was renamed. Earlier tasks without captured
labels retain their connection ID. The existing SDK carries the fields.

A real model called `notes_read` through a scratch Telegram Bot. The production
ingress sent the callable, literal arguments, connection ID, account label and
remote name to a loopback Telegram peer. A fresh ingress instance denied the
same task from the button. The source WebUI read the held decision and task.
ACP history replay initially received HTTP 400 for a 100-turn history request.
With 50-turn pages it replayed the denied task as failed with its raw arguments
and account. Nexus supplied no output preview for that denial.

**Fixtures and platforms.** Development Nexus refused discovery of the loopback
MCP endpoint, so the two scratch catalogs were seeded. The Nexus Rails MCP
execution integration test independently exercises HTTP discovery, a real MCP
tool call and the return to the model through a controlled peer. The ACP peer
test supplies a completed call with `is_error: true` and an output preview.
Telegram fallback, Unicode limits and T3 continuation use controlled peers.
Runtime conformance passed 424 tests on macOS with isolated headless Chromium.
The filename case skipped on macOS passed on Ubuntu. The runtime build, both
type checks, CLI and Server adapter tests, Protocol identifier test and root
`bun run check` passed. The Nexus MCP and contract suites passed 35 tests.
The scratch Bots and MCP connections were removed, the workspace reached
`deleted`, both issued keys were revoked and the scratch Agent reached
`removed`. The installed service was ready on its original Agent and workspace.

## Application and executor

| Reference contracts                                                                                    | TypeScript owner                                                                                                        | Behavioral evidence                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rho`: shared Core conversation operations, daemon authoring hooks, input execution and recovery       | `application.ts`, `admission.ts`, `operations.ts`, `turn-lifecycle.ts`, `sides.ts`                                      | `application.test.ts`, `lifecycle.test.ts`, `operations.test.ts`, `sides.test.ts`: frozen admissions, fail-closed authors, lost responses, restart, explicit model inheritance, exact input/fallback recovery, retained lifecycle owners                                                                                                     |
| `rho`: identity, API keys, Human login, configuration, adaptations and conversation titles             | `runtime.ts`, `login.ts`, `settings.ts`, `workspaces.ts`, `adaptations.ts`, `conversation-titles.ts`                    | `runtime.test.ts`, `login.test.ts`, `configuration.test.ts`, `adaptations.test.ts`, `conversation-titles.test.ts`: credential separation, candidate validation, private persistence, field fallback, model spellings, one title attempt and manual-title precedence                                                                          |
| `rho`: Presets, role declarations, Bot policy and switching                                            | `presets.ts`, `bots.ts`, `bot-policy.ts`, `mutation.ts`                                                                 | `presets.test.ts`, `bots.test.ts`, `policy.test.ts`: compare-and-swap, portable definitions, lost committed responses, archived prior roots, external audience restrictions and requester identity                                                                                                                                           |
| `rho`: memory review/policy, Until, instructions and process ownership                                 | `memory-review.ts`, `memory-policy.ts`, `until.ts`, `conventions.ts`, `processes.ts`                                    | `memory-review.test.ts`, `until.test.ts`, `conventions.test.ts`, `processes.test.ts`: captured revisions, private review forks, acceptance graph recovery, bounded instructions and conversation-owned process retirement                                                                                                                    |
| `rho`: extension registration, settings changes and managed packages                                   | `extension-manager.ts`, `configuration.ts`, `packages.ts`, `worker-extension.ts`, `extension-rpc.ts`, `webui-module.ts` | `extensions.test.ts`, `packages.test.ts`, `worker-extension.test.ts`, `extension-rpc-lifetime.test.ts`: inert disabled code, staged publication, failed-candidate cleanup, retained handler leases, immutable versions, rollback, worker cancellation and remote-reference release                                                           |
| `rho-env`: executor inbox, authoritative claims, admission, orchestration, cancellation and settlement | `runner-inbox.ts`, `runner.ts`, `claim-control.ts`, `claim-result.ts`, `claims.ts`                                      | `executor.test.ts`, `claim-control.test.ts`, `claim-result.test.ts`, `claims.test.ts`: push/HTTP recovery, bounded startup/resources, nested child progress, placement/refusal checks, renewal, canceled-handler ownership and durable settlement without rerunning effects                                                                  |
| `rho-env`: filesystem tools, attachments, checkpoints, environments, skills and terminal transport     | `file-read.ts`, `mutation.ts`, `runner-search.ts`, `checkpoint-store.ts`, `environments.ts`, `skills.ts`, `terminal.ts`, `realtime.ts` | `runner.test.ts`, `mutation.test.ts`, `runner-search.test.ts`, `attachments.test.ts`, `checkpoint-store.test.ts`, `environments.test.ts`, `skills.test.ts`, `terminal.test.ts`, `realtime.test.ts`: complete media transfer, protected roots, fuzzy edits, durable undo, captured roots, skill precedence, real PTYs, WebRTC reconnect and bounded output replay |
| `rho-env`: editor filesystem routing, response validation and failure mapping                          | `runner.ts`, `editor-bridge.ts`, `environments.ts`                                                                      | `editor-filesystem.test.ts`, `executor.test.ts`, `editor.test.ts`, `environments.test.ts`: unsaved buffers, paged reads, missing buffers, EOF, client refusals, broken bindings, malformed acknowledgements, interrupted settlement and disk preservation |

## Extensions and peer surfaces

| Reference contracts                                                                                                     | TypeScript owner                                                                                               | Behavioral evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rho-codemode`: JavaScript binding, frozen catalog, operation receipts and observations                                 | `code.ts`, `orchestration.ts`, `claim-control.ts`                                                              | `code.test.ts`, `executor.test.ts`: native interpreter scheduling, refusal/error distinctions, copied JSON, accepted background ownership, observed-resource forwarding, native execution/data limits and a real native child with one startup slot                                                                                                                                                                                                                         |
| `rho-web-tools`: fetch policy, renderer, captures and operator fetch                                                    | `web.ts`, `approval-grant.ts`, development terminal                                                            | `web.test.ts`, `dev.test.ts`, `policy.test.ts`: bounded same-site redirects, DNS/address filtering, compression/charset handling, whole content-addressed captures, cancellation, literal authority grants and raw operator output                                                                                                                                                                                                                                          |
| `rho-browser`: browser/tab ownership, actions, snapshots and cleanup                                                    | `browser.ts`, `browser-session.ts`                                                                             | `browser.test.ts` with Chromium: shared cookies, per-run tabs, serialized actions, stale refs, frame refs, PNG capture, cyclic/deep/non-finite evaluation results, cancellation, idle retirement and popup cleanup                                                                                                                                                                                                                                                          |
| `rho-mcp`: settings, curation, documents, transports, OAuth and conversation mounts                                     | `mcp.ts`, `mcp-settings.ts`, `mcp-curation.ts`, `mcp-exchange.ts`, `mcp-session.ts`, `mcp-sessions.ts`         | `mcp.test.ts`, `mcp-exchange.test.ts`, `mcp-session.test.ts`, `mcp-sessions.test.ts`, `captured-mcp.test.ts`: exact names/budgets, isolated bad rows, media/results, narrow client capabilities, transport cancellation, session replacement and captured attachment anchors; post-login catalog publication without restarting unchanged servers; OAuth credential completion and refresh also use the Core `integration.test.ts` and `integration-refresh.test.ts` suites |
| `rho-acp`: authentication, sessions, config, slash commands, history, held questions and editor facilities              | `editor.ts`, `editor-auth.ts`, `editor-bridge.ts`, `editor-replay.ts`, CLI adapter                             | `editor.test.ts`, `editor-replay.test.ts`, `editor-permissions.test.ts`, `editor-auth.test.ts`, `runtime.test.ts`, CLI `nexus.test.ts`: authored Human admission, launch defaults, skill commands, runner-scoped roots, paginated role-aware replay, Side context, owned held-work recovery, shared grants, permission cancellation, unsaved buffers and detachment without canceling work                                                                                          |
| `rho-acp-client`: resident delegation, permission floor, captures and process lifecycle                                 | `acp.ts`, `acp-child.ts`, `acp-policy.ts`, `acp-capture.ts`                                                    | `acp.test.ts`, `adapters.test.ts`, `runner-policy.test.ts`: real child sessions, auth/model selection, protected commands/paths, redaction, permission tracking, cancellation quarantine, deadline termination and host-ended release                                                                                                                                                                                                                                       |
| `rho-ingress-telegram`: Connections/Bots, routing/access, durable ingress/delivery, media, schedules, worker results and the outbox pump | `telegram.ts`, `telegram-ingress.ts`, `telegram-transport.ts`, `telegram-workers.ts`, related Telegram modules | `telegram.test.ts`, `telegram-workers.test.ts`, `telegram-cross-bot.test.ts`, `telegram-render.test.ts`, `telegram-transport.test.ts`, `telegram-outbox.test.ts`: requester isolation, debounce, frozen admissions, fixed reply destination, uncertain-send handling, media/voice, schedules, participation, exact canonical worker ownership and outbox delivery verdicts |
| `rho`: Channels, Inbox, Routines, Skill drafts and the Superagent Ops routes | `channels.ts`, `inbox.ts`, `routines.ts`, `skill-drafts.ts`, `superagent-tools.ts`, `operations.ts`, `runtime.ts` | `channels.test.ts`, `inbox.test.ts`, `routines.test.ts`, `skill-drafts.test.ts`, `superagent.test.ts`: gate outcomes, attention budgets, outbox drain, desk ensure, partition classification, snooze/complete, routine projections, draft catalog, operations dispatch and agent-tool announcements |
| `rho-dev`: opt-in conversation controls, streams and terminal rendering                                                 | `dev/extension.ts`, `dev/streams.ts`, `dev/terminal.ts`, `operations.ts`                                       | `dev.test.ts`, `dev-worker.test.ts`, `operations.test.ts`: shared application operations, stream cursors, fallback chains, ownership, cancellation/detachment and worker-bound SDK streams                                                                                                                                                                                                                                                                                  |

## Reference contract anchors

All ten executable non-WebUI packages have production TypeScript owners above.
These reference tests identify the behavioral contracts; the corresponding local
suites exercise the OpenCode implementation rather than executing Ruby.

| Package                | Reference anchors beneath its `test/` directory                                                                                                                      | Local evidence beneath `test/`                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `rho`                  | `api_key_connection_test.rb`, `host_follower_test.rb`, `execution_policy_test.rb`, `package_activation_test.rb`, `memory_review_test.rb`, `until_test.rb`, `channels_routines_inbox_test.rb`, `skill_drafts_test.rb` | `runtime`, `application`, `lifecycle`, `packages`, `memory-review`, `until`, `channels`, `inbox`, `routines`, `skill-drafts`, `superagent`, `speakers` |
| `rho-env`              | `runner_execution_test.rb`, `claim_orchestration_test.rb`, `cancellation_recovery_test.rb`, `fs_port_test.rb`, `tools/read_test.rb`, `tools/write_test.rb`, `tools/edit_test.rb`, `checkpoints/store_test.rb`, `webrtc_transport_test.rb`, `deadline_extension_test.rb` | `executor`, `claims`, `claim-control`, `claim-progress`, `runner`, `mutation`, `editor-filesystem`, `checkpoint-store`, `terminal`, `realtime` |
| `rho-codemode`         | `code_test.rb`, `runtime_test.rb`, `claim_bridge_test.rb`                                                                                                            | `code`, `executor`                                                                            |
| `rho-web-tools`        | `client_test.rb`, `render_test.rb`, `commands_test.rb`                                                                                                               | `web`, `policy`, `dev`                                                                        |
| `rho-browser`          | `tools_test.rb`, `session_test.rb`, `session_idle_test.rb`, `session_popups_test.rb`                                                                                 | `browser` with real Chromium                                                                  |
| `rho-mcp`              | `curation_test.rb`, `documents_test.rb`, `post_login_refresh_test.rb`, `conversations_test.rb`                                                                       | `mcp`, `mcp-session`, `mcp-sessions`, `mcp-exchange`, `captured-mcp`                          |
| `rho-acp`              | `acp/reference_replay_test.rb`, `acp/recovery_attach_test.rb`, `acp/permissions_test.rb`, `acp/materialization_test.rb`                                              | `editor-replay`, `editor-permissions`, `editor`, `application`, `runtime`                     |
| `rho-acp-client`       | `tool_test.rb`, `children_test.rb`, `policy_test.rb`, `cancel_reuse_test.rb`, `child_retirement_test.rb`                                                            | `acp`, `attachments`, `adapters`, `runner-policy`                                             |
| `rho-ingress-telegram` | `routing_test.rb`, `input_batch_test.rb`, `recovery_test.rb`, `delivery_test.rb`, `worker_result_delivery_test.rb`, `personal_reach_outbox_test.rb`                   | `telegram`, `telegram-workers`, `telegram-cross-bot`, `telegram-render`, `telegram-transport`, `telegram-outbox` |
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
  Editor filesystem capabilities require this machine's runner. Agent-owned editor MCP mounts also work with a remote runner. Models are listed
  with Nexus's `text_generation` workload.
- Approval defaults remain Ask. Optional integration defaults remain OpenCode's.
  Development controls remain source-only. UI layout, host document-title control,
  model-management policy and other deployment decisions remain owned by nexus-ui.
- The Superagent stores (`rho.channels`, `rho.inbox`, `rho.skill_drafts`) keep the
  reference namespaces and keys. Their mutations retry a Conflict up to eight
  attempts at the call site, matching the reference's CAS hardening; the shared
  `StoreDocument` reconcile semantics are unchanged.
- Personal-desk conversations carry `opencode.surface: "personal_desk"` metadata,
  the runtime's established metadata namespace, where the reference writes
  `rho.surface`. Draft and rule public IDs use `crypto.randomUUID()` rather than
  UUIDv7. Quiet hours honor the configured `time_zone`; the reference formats in
  UTC. The Telegram outbox pump drains enabled connections only.
- `rho-t3` has no TypeScript successor: the reference removed the package, and the
  runtime, UI and their tests removed the corresponding owners in the same review.

## Verification

`bun run test:conformance` requires `OPENCODE_NEXUS_CHROMIUM` pointing at an isolated
Chromium executable. It exercises the production owners with local HTTP/WebSocket,
MCP, OAuth, ACP child fixtures, real browser, PTY and WebRTC transports.
On macOS, the Playwright `chrome-headless-shell` executable also satisfies this
gate and avoids the full Chrome application's display-process startup dependency.

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

The review retains the production owners above for all eleven executable non-WebUI
packages. It follows registration through dispatch, results and retirement against
the reference code and contract tests. `rho-webui` remains owned by `packages/nexus-ui`;
the empty `rho-runner` directory introduces no additional executable package.

Four differences were reproduced and corrected in the existing owners:

- `rho-acp-client`'s `Policy.command_text` falls back to the permission title when
  the raw command is absent or empty. `acp-policy.ts` now does the same for empty
  strings and arrays, retaining the shared refusal floor even when the row allows
  child actions. `runner-policy.test.ts` exercises the actual decision with a
  tracked execution call and an empty command in its permission request.
- `rho-mcp`'s `Naming.tool` replaces each non-ASCII character once.
  `mcp-settings.ts` now normalizes Unicode code points rather than UTF-16 halves.
  The `mcp.test.ts` vectors were checked against the reference implementation,
  including its SHA-256 suffix. Raw remote names and document naming stay intact.
- `rho-t3`'s `Catalog.select` trims agent and model choices before selection.
  `t3-catalog.ts` now accepts those choices and treats a blank model as the provider
  default. `t3.test.ts` retains unavailable and ambiguous-choice refusals.
- Live Bot creation exposed a handle mismatch: the `bot-` prefix and stable name
  must fit Nexus's 32-character handle route. The public creation and duplication
  schemas now accept at most 28 characters; the UI enforces that limit and reserves
  space for its duplicate suffix. Schema and browser regressions cover the boundary.

The Bot command validation is the only public contract change. Client generation
was run from `packages/client`; the generated TypeScript shape remains a string.
These fixes add no endpoint, configuration key or dependency. Native Code Mode,
MCP/OAuth, shell, filesystem, snapshot and PTY facilities retain their existing
owners. The existing `nexus_runtime` flag guards the integration.

Validation passed 310 runtime conformance tests across 69 files with real Chromium,
PTY and WebRTC, both runtime TypeScript checkers and the runtime build. The CLI/Server
Nexus adapter tests and Protocol experimental-identifier test passed. The UI passed
403 unit tests, 65 browser tests, its type check and build; all 107 Schema tests and
the Schema official TypeScript check passed. Root `bun run check`
passed with the existing advisory-warning backlog. The recorded-review browser test
now clicks the shared component's line-number gutter to open its comment editor;
the corrected case also passed three isolated repeats.

Local Nexus acceptance verified runner file reads/edits, artifact publication and a
matching Human download, OpenCode bash dispatch, automatic/custom/disabled memory
bindings, runtime schedule creation/pause/resume/cancellation, and Bot Home Workspace,
Preset, conversation and duplication behavior at the 28-character boundary.

A model-driven native Code Mode execution ran one approved bash effect, printed an
unpredictable UUID and retained structured false. The next sealed model request
contained the UUID, the UI answer survived reload, and a scratch counter confirmed
one bash execution. A real terminal used the production browser WebRTC transport;
reload/reattachment retained output and a shell variable, and Stop settled its task.
Temporary Bots, Presets, workspaces, terminal tasks and files were removed through
the public APIs, preserving service pairing and defaults without a service restart.
Telegram, T3 and external ACP account interoperability remains covered by local
protocol fixtures.

## Additional behavioral pass

A second pass against the same Rho revision reproduced and corrected the following
differences in the existing runtime and WebUI owners:

- Telegram schedule creation and prompt edits preserve internal newlines and
  spacing, as `ScheduleCommands` does. Time expressions consume the complete
  argument, require seconds in offset timestamps, accept colonless UTC offsets
  and allow `in 0s` for immediate rescheduling. Repeating intervals remain
  positive. Controls reject unexpected text after their job ID. The ingress
  regression covers create, edit and a malformed pause without sending it.
- Answer-file downloads resolve relative paths against the conversation's stored
  environment, matching `Extensions::Ops::Files.conversation_root`, rather than
  the runner's global default. The UI passes the displayed relative path to the
  runtime, which owns resolution and confinement. The actual runtime operator
  regression uses different default and bound directories, checks the submitted
  tool path and rejects parent, hidden and outside-root paths before submission.
- Failed browser module registration rolls back contributions and retains the
  failed version across inventory refreshes. Disable/re-enable or a version
  change permits another attempt, matching the reference module host. Disposal
  also removes the failure diagnostic.
- Plugin forms unset a blank nullable text field rather than storing explicit
  null, matching the reference form's default semantics. Maps show saved dynamic
  entries alongside declared properties, so existing entries remain editable.

Each regression failed before its fix. Validation passed 312 runtime conformance
tests across 69 files with real Chromium and WebRTC, both runtime TypeScript
checkers and the runtime build, 403 UI unit tests and 68 browser component tests,
the UI type check/build and root `bun run check`. The three new browser cases also
passed three isolated repeats. This pass used local protocol/browser fixtures and
did not restart or mutate either running service. No public Protocol/HttpApi,
dependency, configuration key or endpoint changed; client regeneration was not
needed.

## Live verification after rebuilding the service

The rebuilt managed service was verified against Nexus at `http://localhost:3000`
with an isolated development Nexus UI. A conversation bound to a separate scratch
directory downloaded its exact file bytes through the service operator; parent,
hidden and outside-root paths were refused. A live model answer linked the file,
and the production UI preview/download returned the same bytes before and after
reload, without changing the runner default directory.

Live plugin configuration writes verified nullable text as an unset operation,
restored its runtime default and survived reload. The disabled MCP extension's
saved dynamic URL entry remained visible alongside declared fields, accepted an
edit and retained it after reload. Switching from one plugin to another exposed
an additional UI issue: its heading changed while the previous form and draft
remained mounted. The UI now keys the form by the selected extension ID, retaining
same-plugin drafts during inventory refresh. The new
browser regression failed before the fix and passed three repeats afterward.
The live cross-plugin configuration workflow then passed, including refresh with
an unsaved draft.

The production Telegram command parser created and edited real Nexus schedules
with exact multiline prompts, accepted a colonless UTC offset and refused malformed
controls without mutating the job. Paused state and the exact prompt survived UI
reload. Telegram transport was not connected: parser calls used a temporary owner
Bot without an external requester. Browser-module failure/refresh/disable/re-enable
and replacement were checked in the production UI using a browser-only controlled
module appended to the live inventory; no package was installed on the service.

Temporary schedules, Bot, workspace, profile records and scratch files were removed.
Plugin configuration values were restored, optional integrations remained disabled,
and service pairing, Agent, default workspace and runner directory were unchanged.


## Built-in execution settings alignment

The current checkout's production source and reference tests remain unchanged.
The package mapping above still covers all eleven executable non-WebUI packages;
`rho-webui` is implemented by `packages/nexus-ui`, and `rho-runner` has no tracked
source. The review found configuration behavior missing from otherwise working
execution owners:

- `rho.coding` maps to `nexus.coding`, including enablement and the configurable
  120-second bash default (1–540 seconds). Explicit call timeouts win. Native bash
  now opts out of claim renewal, matching its reference internal clamp.
- `rho.checkpoints` maps to `nexus.checkpoints`. Retention, file/tree budgets and
  capture deadlines feed the existing SQLite store, including alternate captured
  roots. Disabling it stops capture and checkpoint dispatch while preserving history.
- `rho.lifecycle_hooks` maps to `nexus.lifecycle-hooks`. Complete optional hook groups
  publish through existing application declarations; Nexus executes Agent-service
  hooks. Preset overrides and captured admissions keep their existing owners.
- Until reads the configured bash timeout for new plans and recovery gates. Submitted
  checks keep their recorded timeout. Configuration refreshes remove disabled coding
  and checkpoint tools from announcements and declarations as well as native dispatch.

`execution-settings.ts` owns these descriptors and their typed runtime projection.
`runner-inbox.ts` captures built-in policy before claiming so a running handler
retains its original timeout and checkpoint options. The experimental executor's
optional `builtins` policy callback leaves existing custom hosts compatible.

The UI's existing Plugins form presents these settings; atomic hook groups use its
JSON editor. Browser coverage saves and resets settings, reloads persisted hooks,
rejects malformed JSON and checks draft isolation between plugins. Existing UI
edits were preserved, including the keyed form remount fix.

Validation passed 316 runtime conformance tests with real Chromium/PTYs/WebRTC,
both runtime type checkers and build, 403 UI unit tests, 70 browser tests, UI type
check/build, CLI/Server Nexus adapter tests, Protocol identifier checks and root
`bun run check`. Existing lint and UI build advisories remain. No public HTTP or
Protocol shape changed, so client regeneration was unnecessary.


Live validation used a temporary source runtime and Agent against development
Nexus. Native Code Mode printed an unpredictable bash token, retained structured
false and returned the token to the model; a scratch counter confirmed one effect.
Both that call and the Until check reached OpenCode's native shell with the saved
42-second timeout. An explicit five-second call overrode it. Nexus executed the
Agent-service lifecycle hook, checkpoint restore removed the generated file, and
disabled coding/checkpoint tools disappeared from the executor announcement.
A separate Ask rule held bash until the existing Human credential approved it.
Temporary workspaces and the Agent were removed, and its credentials were verified
rejected. The installed service was not restarted. The new settings browser case
also passed ten repeats with two workers.


## Rebuilt managed-service verification

Live verification against development Nexus after rebuilding and restarting the
installed service confirmed all three settings descriptors and their defaults.
The production Plugins UI saved a two-second bash default and retained it after
reload. Native bash enforced that limit; an explicit five-second limit and Human
approval completed a longer command. An active call retained its original timeout
when the default changed, and a short claim expired without bash renewing it.

Checkpoint checks exercised configured file/tree budgets, a captured temporary
root, restore, and disablement without new captures. Coding disablement removed
its announcements and Nexus refused a new call with `tool_not_served`; Code Mode
remained available. A temporary agent-role MCP tool verified lifecycle-hook JSON
save/reload and actual `turn_start` execution for the tested conversation. The
managed model called bash once through Code Mode, printed its output and retained
structured false. Until's recorded input used the configured five-second timeout,
and the completed answer survived browser reload. Five invalid settings edits
were rejected without changing the saved configuration.

All settings, pairing and defaults were restored; test workspaces and local scratch
resources were removed. No service restart was required during verification. The
executor retained the generic last-error marker already present before the first
check; direct HTTP inbox reads and live dispatch worked throughout. That snapshot
contains no error detail or timestamp, so its original cause was not established.


## Executor issue recovery

The generic executor marker was reproducible as a status defect: the SDK's error
classes inherit `Error.name`, and a successful recovery sweep previously never
cleared the saved issue. A malformed inbox response reproduced exactly
`{type: "Error", code: null}`; an HTTP 503 remained recorded after the next healthy
sweep. These reproductions identify the diagnostic defects, not the exact original
exception from the installed process, whose message was discarded. Startup Nexus
logs showed successful inbox responses and no current journal failure remained.

`RunnerInbox` now classifies SDK failures with stable labels that survive executable
minification. Only a clean idle sweep retires an older issue. A newly reported claim
failure, a handler that still owns work, an unreconciled journal or fatal authority
loss cannot be hidden by that recovery. Status still excludes response bodies,
credentials and exception messages; no public Protocol shape changed.

All three regressions failed before the fix. Validation passed 319 runtime
conformance tests, both runtime type checkers, the runtime build and root
`bun run check`. A minified diagnostic executor against live Nexus simulated one
malformed response, reported `MalformedResponse`, then cleared the issue after a
successful HTTP sweep. It claimed no tasks and changed no live credentials,
pairing or configuration. The installed service needs rebuilding/restarting to
apply this source change; its historical marker was not modified in place.

After the subsequent rebuild/restart, live verification exercised the installed
managed service itself against development Nexus. A temporary recovery record
with an invalid HTTP header produced `TransportError`; a malformed JSON recovery
record produced `SchemaError`. Each issue remained visible across two further
sweeps while its fault persisted, then became `null` on the first healthy idle
sweep after removing the record. The executor stayed running throughout.

A subsequent native bash task completed through the same runner and returned its
unique output token, leaving no in-flight work or issue. The test workspace,
scratch directory, recovery records and test checkpoint store were removed.
Pairing and saved settings were unchanged, and verification did not restart the
service or interrupt Nexus.

## Non-WebUI contract review, November 17, 2026

The reference remains `f5e4899094d8bb3ab5fdc653c7426bd7f5c226b6`.
The package inventory, production registration/dispatch paths and reference
contracts were checked against the owners and tests in the tables above:

- `rho`: application admission/recovery, credentials, configuration, Presets/Bots,
  memory, Until, conventions, titles and staged extension/package ownership.
- `rho-env`: authoritative inbox claims, renewal and cancellation, placement,
  filesystem/shell output, attachments, checkpoints, skills, processes and terminals.
- `rho-codemode`: frozen declarations, argument validation, native operations,
  observation ordering, ownership transfer and selected/printed output.
- `rho-web-tools` and `rho-browser`: fetch/address/redirect policy and captures;
  readiness, per-run tabs, frame references, actions, idle and popup cleanup.
- `rho-mcp`: naming, schema curation, budgets, documents, transport cancellation,
  OAuth publication and editor-scoped mounts through OpenCode's MCP owner.
- `rho-acp` and `rho-acp-client`: session/authentication, prompt conversion,
  replay and held-work recovery, editor attachments, delegation policy and children.
- `rho-ingress-telegram`: settings, routing/access, frozen admission, debounce,
  uncertain delivery, media/voice, schedules, participation and worker ownership.
- `rho-t3` and `rho-dev`: native catalogs/assignment ownership and reconciliation;
  source-only commands, scoped operations, stream cursors and approval grants.

Two boundary differences were reproduced and corrected:

- Rho's `ConversationTitles::INPUT_CHARACTERS` and `TITLE_CHARACTERS` count
  Unicode characters. `conversation-titles.ts` now retains 4,000 input code points
  and 255 title code points. UTF-16 slicing previously split an emoji at either
  limit, producing an unpaired surrogate. `conversation-titles.test.ts` exercises
  both limits through the production title owner, retaining one-attempt and Side
  cleanup behavior.
- Rho's `Env::Skills::NAME_MAX_LENGTH` is 64. The repeated optional hyphen in the
  operator's former regular expression allowed a 65-character name. The shared
  `skillOperation` boundary now enforces the total length for show, push and remove
  before collection lookup. `dev.test.ts` checks all three refusals, an accepted
  64-character name and the existing stale-revision refusal without mutation replay.

Both regressions failed before the fixes. The two affected test files passed ten
repeats afterward. Full validation passed 320 runtime tests across 69 files with
real headless Chromium, PTY and WebRTC, both runtime type checkers, the runtime
build, two CLI adapter tests, one Server/generated-client adapter test, all 76
Nexus UI server/bridge tests and root `bun run check`. The root lint gate retains
the existing advisory-warning backlog with zero errors.

Live checks used development Nexus at `http://localhost:3000`, the existing
standalone UI's server-side Human credential and an isolated workspace. The source
title owner submitted an input whose 4,000th character was an emoji, generated a
title, retained one durable attempt and removed its temporary Side. A 255-character
title ending in an emoji persisted and read back exactly. Source skill operations
refused a 65-character name and pushed/read/removed a 64-character workspace skill.

The running managed service separately completed a Human-approved native Code
Mode call. Bash generated an unpredictable UUID, printed it for the model and ran
exactly once, as confirmed by a scratch counter. The answer included that UUID and
task inspection retained structured `false`. The temporary workspace and files
were deleted; service pairing, the default workspace and Agent were preserved.
Neither service was restarted. The two source fixes require a subsequent managed
service rebuild/restart to reach its installed executable.

No Protocol, HttpApi, configuration key or feature flag changed. The established
native substitutions remain intentional. `rho-webui` remains owned by
`packages/nexus-ui` and its parity document; `rho-runner` has no reference source
or tests and contributes no separate application. Optional external accounts were
represented by local peers in the conformance gate; this review does not claim
external Telegram/T3 account interoperability or identical Ruby language semantics.

## Search and skill contract follow-up, November 17, 2026

The reference checkout still matches `f5e4899094d8bb3ab5fdc653c7426bd7f5c226b6`.
The package inventory and the production registration/dispatch owners above cover
`rho`, `rho-env`, `rho-codemode`, `rho-web-tools`, `rho-browser`, `rho-mcp`,
`rho-acp`, `rho-acp-client`, `rho-ingress-telegram`, `rho-t3` and `rho-dev`.
The established native substitutions remain intentional. `rho-webui` continues
to use the separate Nexus UI parity document; `rho-runner` remains empty.

The existing 320-test gate passed before this pass, but did not protect four
reference behaviors in `rho-env`:

- `test/tools/find_test.rb` requires one reversible display record for a filename
  containing a newline. `runner-find.ts` now JSON-escapes display paths and includes
  exact emitted paths in `structured_content.paths` when escaping is needed.
  Trailing whitespace and directory suffixes remain intact.
- The same reference suite budgets the rendered relative paths, rather than fd's
  absolute stdout. A root longer than 600 bytes previously reduced 100 short
  results to 73 while displaying less than 1 KiB. Streaming NUL records now retain
  all 100 and apply the 50 KiB display cap after relativizing/escaping. Result-limit
  and truncation details follow Rho; existing TypeScript boolean flags remain.
- `test/tools/find_test.rb` and `test/tools/grep_test.rb` require process-group
  cleanup on normal/error exits, result limits and cancellation, plus bounded
  records/stderr and cancellation despite detached pipe holders. `search-process.ts`
  now shares those responsibilities between fd and rg, reusing `OwnedProcess` on
  POSIX with separate stderr capture. Existing process consumers retain combined
  output. Windows retains native child handling; the POSIX ownership cases are
  tested on POSIX. A completed stdout stream waits for the leader's recorded exit
  before cleanup, preserving the actual status.
- `lib/rho/env/skills.rb` treats a null frontmatter name as omitted. `skills.ts`
  now accepts it while still refusing mismatched names and non-string values.

`runner-search.test.ts` exercises these contracts through real fd/rg and controlled
local child executables; `skills.test.ts` exercises the production parser. The
initial regressions failed before implementation. Both focused files passed ten
repeats; the additional detached-stderr cases also passed ten repeats.

Validation passed 333 runtime conformance tests across 69 files with real Chromium,
PTY and WebRTC, both runtime type checkers, the runtime build, two CLI adapter
tests, one Server/generated-client adapter test, all 76 Nexus UI bridge/server
tests, and root `bun run check` (227 existing advisory warnings, zero errors).

Live verification against development Nexus used a temporary source runtime and
Agent. Durable tasks retained escaped filenames and exact structured paths,
returned all 100 short filenames under a long root, and returned grep matches.
Native Code Mode invoked find and one Human-approved native bash call, printed
their results, and retained structured `false`. A skill with `name: null` was
parsed, published to workspace memory, read back and removed.
Stopping a live standalone grep Run canceled its task, retired the source
executor's handler and killed the wrapper's descendant. Temporary workspaces,
the Agent, shell captures, private credentials and scratch files were removed;
both temporary credential planes were verified rejected with HTTP 401. The
installed service retained its original Agent/workspace and remained ready with
no in-flight work or executor issue. Neither service was restarted.

No public Protocol, HttpApi, configuration key or feature flag changed. Production
and CI require neither Ruby nor the reference checkout. Optional integrations
remain covered by local transport peers; this pass does not claim external
Telegram/T3 account interoperability. Applying these source fixes to the installed
managed service requires rebuilding/restarting it.

## Installed Node service verification, November 17, 2026

The rebuilt service at revision `aa0c896aeef35e632f670c4a7444f0ab3b8db948`
exposed a portability regression that the earlier Bun-hosted source checks did not
exercise: find and grep used `Bun.which`, but the installed Node service has no Bun
global. Real find and grep tasks were claimed by the existing managed runner and
settled as failed with `Bun is not defined`. This prevents verification of search framing,
budgets and cancellation on that installed revision.

Both owners now use OpenCode Core's existing portable `util/which` implementation,
including fd/fdfind fallback and the current process PATH. The regression in
`runner-search.test.ts` bundles/minifies the production dispatcher and runs it in
a real Node child without Bun globals. It checks missing executables and, when
installed, successful fd/rg calls. It failed before the fix, passed afterward and
passed ten repeats. Full verification passed 334 runtime conformance tests, both
runtime type checkers, the runtime build and root `bun run check` (227 existing
advisory warnings, zero errors).

The installed service independently accepted a temporary project skill with
`name: null` and published its name through `application.skills` after reactivation
of the skills extension. Removing the fixture and reactivating restored the exact
original skill catalog. Temporary workspaces and the skill fixture were removed;
the original pairing, default directory and extension enablement were retained.
The managed service remains ready with no in-flight work or executor issue.

The portable lookup fix is source-only until the next rebuild/restart. The search
checks above must be repeated against that executable; the earlier source-runtime
success is not evidence that the installed revision passes them.

## Editor filesystem contract completion, November 17, 2026

The reference remains `f5e4899094d8bb3ab5fdc653c7426bd7f5c226b6`. This pass
rechecked the eleven non-WebUI packages through their registration/dispatch owners
and the contract evidence above: application admission and extension lifetimes;
executor claims, files and terminals; frozen native Code Mode operations; web and
browser ownership; MCP curation, transports and documents; both ACP directions;
Telegram routing/delivery; T3 assignments; and source-only development controls.
The documented native OpenCode substitutions remain accepted. Optional integration
evidence uses controlled peers over real transports; it does not establish external
Telegram/T3 account interoperability. `rho-webui` continues to belong to
`packages/nexus-ui`, and `rho-runner` contains no tracked implementation.

The existing gate passed before this pass but omitted editor failure contracts in
`rho-env/test/fs_port_test.rb`, `rho-env/test/tools/read_test.rb`,
`rho-env/test/tools/write_test.rb`, `rho-env/test/tools/edit_test.rb` and the
application's `lib/rho/extensions/environment/fs_port.rb`:

- A timeout fell back to disk without retiring the live binding. Plain server errors,
  bearer refusals, malformed JSON and malformed read responses did not follow the
  unavailable-editor path. The shared filesystem request boundary now validates
  responses, classifies these failures and drops only its matching binding. Read
  and write requests have 30- and 60-second deadlines, including body consumption.
- An editor write returning JSON null was reported as successful. Writes now require
  an acknowledgement object using the existing native shape. Unavailable or malformed
  responses during writes or either half of an edit report an error without writing
  to disk or replaying the mutation. A missing buffer still permits disk access for
  that call, except after an edit has attempted its buffer write.
- A failed disk fallback discarded the editor notice. The notice now survives with
  the disk error, while ordinary reads retain exactly one notice. Client refusals
  name the editor and typed EOF errors use the requested offset. Structured editor
  root refusals remain refusals.
- Editor cancellation was completed as a tool error. It now propagates through the
  existing claim interruption type to failed settlement; an already-aborted execution
  retains its own reason. Cancellation leaves the binding available for later work.

`editor-filesystem.test.ts` covers these cases through the production `RunnerInbox`
and real loopback HTTP, including durable outcomes, unsaved buffers and pagination,
no repeated mutation, binding replacement, disk preservation and execution aborts.
Sixteen new cases failed before implementation; the two existing-behavior cases
already passed. All eighteen cases passed ten repeats after the fixes. The existing
executor and ACP bridge suites also pass. The README now points to this document
for its reference revision rather than maintaining a stale independent baseline.

Validation passed 352 runtime conformance tests across 70 files with isolated
headless Chromium, PTYs and WebRTC, both runtime type checkers and the runtime build,
two CLI adapter tests, one Server/generated-client adapter test, all 76 Nexus UI
server/bridge tests and root `bun run check`. Root lint retains 227 existing advisory
warnings and zero errors. The portable search lookup change committed during this
work remains included in the combined validation.

Live development Nexus verification used a temporary source runtime and Agent.
Durable tasks read unsaved editor content, refused a malformed write acknowledgement
without changing disk, retired the binding, and read disk on the following call
without contacting the retired editor. A reported editor timeout returned one
notice plus disk content and removed the live binding; editor cancellation settled
as failed work. Temporary workspaces, the Agent, both credential planes and scratch
files were removed; the two credentials were verified rejected with HTTP 401.

The installed managed service independently completed a Human-approved native
Code Mode call that ran bash once, printed an unpredictable UUID, retained structured
false and published a file whose downloaded bytes matched the UUID. The execution
counter confirmed one bash call. Stop canceled a separate claimed native bash task.
Temporary resources were removed and its pairing, Agent and default workspace were
preserved; it remained ready with no in-flight work or executor issue. The editor
fixes were verified from source and require a managed-service rebuild/restart to
reach the installed executable.
No public Protocol, HttpApi, SDK or configuration surface changed; no new flag or
Ruby dependency was introduced.

## Rebuilt editor filesystem live verification, November 17, 2026

The rebuilt managed service (`0.0.0-dev-202611171542`, PID 47954) passed 21 grouped
checks across 36 durable tasks against development Nexus at `http://localhost:3000`.
Tasks were claimed by the installed service's existing Runner. The checks used an
isolated workspace, scratch files and a controlled loopback editor; the service's
process, pairing, Agent, Runner, default workspace and directory remained unchanged.

- Valid reads, writes and edits used unsaved buffers without changing disk; paging
  and both typed and empty-buffer EOF responses preserved their contracts.
- Reported timeouts, plain HTTP 503, bearer refusal, malformed refusal/JSON/read
  responses and null reads retired the matching binding. Reads returned one notice
  plus disk content; the following call skipped the retired editor. Missing disk
  files retained the editor notice alongside the filesystem error.
- Null and array write acknowledgements, and malformed responses during either
  half of an edit, refused completion without changing disk or replaying writes.
  Missing buffers permitted per-call disk fallback, while an edit's write-half
  not-found response never wrote disk. Structured root refusals retained the binding
  and named the editor.
- Editor cancellation during reads, writes and either half of an edit settled as
  failed work, retaining the binding and leaving disk unchanged.
- Two stalled response bodies exercised the actual 30-second read and 60-second
  write deadlines concurrently. The read retired its binding and returned disk
  content; the write retired its binding and reported an error without changing
  disk. Both finished within the 61-second observation window.

A separate Human-approved model workflow on the same installed service used native
Code Mode to run bash exactly once, print an unpredictable UUID, retain structured
false and publish/download a file with matching bytes. Temporary workspaces and
files were removed. The service remained ready with zero in-flight tasks and no
executor issue. This verifies the editor fixes in the installed executable and
supersedes the earlier source-only deployment limitation.

## File mutation queue review, November 18, 2026

The reference remains `f5e4899094d8bb3ab5fdc653c7426bd7f5c226b6`. The package
inventory and registration/dispatch review retain the TypeScript owners above for
all eleven executable non-WebUI packages: application/admission and extensions;
executor files, processes, checkpoints and terminals; native Code Mode; web and
browser tools; MCP catalogs, documents and transports; both ACP directions;
Telegram routing/delivery; T3 assignments; and source-only development controls.
The documented native OpenCode substitutions remain in effect. `rho-webui` stays
with `packages/nexus-ui`, and `rho-runner` has no tracked executable implementation.

`rho-env/lib/rho/env/file_mutation_queue.rb`, `tools/write.rb`, `tools/edit.rb`
and `test/toolsets_test.rb` establish that same-file mutations serialize across
captured roots and symlink aliases, including files below missing parents, while
different files remain independent. Waiting for a file must remain cancelable.
Review reproduced two gaps in `mutation.ts` despite the passing baseline gate:

- Disk and editor mutations checked cancellation only after the preceding writer
  exited. Their shared queue now rejects a canceled waiter with its original abort
  reason immediately, without invoking its action. Later writers still wait for
  the actual holder. An active mutation retains its lock until its action exits.
- Editor mutations used lexical paths as queue keys. They now use the same
  canonical destination resolver as disk mutations. Editor requests retain their
  original absolute paths. Concurrent edits through aliases preserve both changes,
  including unsaved files below missing directories, without changing disk files.

`mutation.test.ts` covers cancellation for disk/editor waiters, abort reasons,
failure recovery, independent paths and active-editor ownership after cancellation.
`editor-filesystem.test.ts` exercises alias edits through production `runClaim`
and real loopback HTTP, plus cancellation and handler release through `RunnerInbox`.
Four new cases failed against the original implementation; the active-ownership
and runner-cancellation checks already passed. Both focused suites passed ten
repeats after the changes.

Validation passed 358 runtime conformance tests across 71 files with isolated
headless Chromium, PTYs and WebRTC, both runtime type checkers, the runtime build,
two CLI adapter tests, one Server/generated-client adapter test, all 76 Nexus UI
server/bridge tests and root `bun run check`. Root lint retains existing advisory
warnings and no errors, with no warnings in the changed runtime files. Optional
integrations use controlled HTTP/RPC/process peers over real transports; external
Telegram/T3 account interoperability is outside this gate.

Live development Nexus checks used a temporary source runtime and Agent. Durable
tasks serialized two edits through symlink aliases for existing and missing nested
files, preserved the editor request paths and left disk unchanged. Stop canceled
a queued writer and released its handler while another task still held the file;
the canceled writer never reached the editor. Temporary workspaces, the Agent,
credentials and scratch files were removed, and both temporary credential planes
were verified rejected with HTTP 401.

The installed `48250ef8` service separately completed a Human-approved native
Code Mode workflow: exactly one bash execution printed an unpredictable UUID,
retained structured false and published a file with matching downloaded bytes.
Stop also canceled a claimed native bash task through an Agent-owned application
operation. Direct Human-authored standalone dispatch to that Runner was refused
with `runner_not_eligible`, preserving the credential boundary. Temporary
workspaces and files were removed; the managed service remained ready with zero
in-flight tasks, no executor issue and its original pairing and default workspace.

These fixes require rebuilding the installed managed service. No public Protocol,
HttpApi, SDK, configuration or storage format changed, and no new flag is needed.

## ACP content and MCP reporting review, November 18, 2026

The eleven non-WebUI runtime owners and their reference anchors were checked
against Cybros `f5e4899094d8bb3ab5fdc653c7426bd7f5c226b6`. The existing
OpenCode service, extension registrations and executor paths own those
capabilities. The WebUI correspondence is recorded in `packages/nexus-ui`.

- `rho-acp/test/acp/content_test.rb` defines embedded text and resource-link
  formatting. `editor.ts` preserves the URI and fenced context and validates the
  full prompt before starting any upload. Media must decode as standard base64
  and fit the 16 MiB decoded attachment limit. Embedded PDFs remain an explicit
  OpenCode extension. Uploaded files carry a media extension.
- `rho-acp-client/lib/rho/acp-client/call.rb` keeps whole answer lines within
  2,000 lines and 50 KiB. `acp.ts` and `acp-child.ts` use these limits and report
  truncation with the existing transcript capture. Progress carries the newest
  4 KiB, preserving UTF-8 and dropping a leading partial line when possible.
- `rho-mcp/test/curation_test.rb` measures the model-facing tool declarations
  separately from the executor announcement. `mcp-curation.ts` uses the bundled
  SDK's tool lowering for `mcp.list` and `mcp.probe`. The 65,536-byte admission
  limit still uses the full executor announcement.

The focused regressions, all 359 runtime conformance tests with Chromium, PTY
and WebRTC, both runtime type checks, the build, the CLI and Server adapter
tests, the 76 Nexus UI bridge tests, and root `bun run check` passed.

Live checks used the patched source at OpenCode base `f8d09bea454` against
development Nexus. A real ACP session submitted the fenced text and both
attachments through shared Human admission. The image and PDF downloaded with
matching bytes, and malformed media was refused before upload. A real ACP child
produced bounded answer text and progress, and the published Nexus upload
retained the omitted text. A loopback MCP peer reported 119 bytes through both
management commands. The temporary workspace, Agent, uploads and credentials
were cleaned up. The installed service remained ready on its original build.

## ACP PDF forwarding, November 18, 2026

- Rho now accepts PDF resource blobs on new ACP prompts. OpenCode rejects them
  with ACP `-32602` on surface commands and held answers before staging an upload.
  The regressions in `editor.test.ts` check both entry points.
- The `delegate_agent` tool accepts ordered PDF upload IDs or Nexus attachment
  URIs. The child must advertise ACP `embeddedContext`. The runner uses the
  current claim's attachment capability for descriptor and byte reads. It checks
  MIME type and the 16 MiB per-file limit before opening a body, and verifies
  the downloaded length before prompting the child. The same reader serves
  `file_import`, which retains its large-media support.
- The child receives the original PDF bytes as embedded resources. The outgoing
  ACP transcript records the canonical URI, MIME type and decoded size. The
  `attachments.test.ts` regression uses real ACP stdio and HTTP attachments to
  verify byte hashes and order, including a 16 MiB PDF. Unknown, inaccessible,
  truncated and unsupported attachments refuse the whole child prompt.

The installed OpenCode service at `ffa01412d19` completed an ACP prompt
with a synthetic PDF against development Nexus. Nexus preserved the PDF MIME
type and returned all 624 original bytes. The sealed request for the configured
`deepseek/deepseek-flash` model carried the attachment reference. The scratch
conversations and uploads were cleaned up.

A temporary source runtime at OpenCode base `ffa01412d19` executed a durable
Nexus `delegate_agent` task. A real ACP child received the byte-identical PDF,
and the capture downloaded from Nexus contained its metadata. The workspace,
uploads, Agent and both credentials were retired. The 360-test Chromium, PTY
and WebRTC conformance gate, both runtime type checks, runtime build and root
`bun run check` passed.

## Conversation history, Telegram, and output review, November 18, 2026

The TypeScript entry points and reference test anchors above were checked at
Cybros `3e5d0877da1`. The managed runtime composes the shared application and
executor. The optional tool and ingress surfaces register through the runtime's
extension manager. The CLI starts the ACP peer, and the development extension
calls the shared application operations. The ACP PDF, delegated attachment, and
claim reader tests cover the production delta from `f5e4899094`.

- `rho` and `rho-dev` use an exclusive reverse window when resolving idle
  results and the regeneration tail. The model inheritance test crosses a
  100-turn page boundary after finding no qualifying reply in the newest page.
  Forward cursor consumers still advance from their saved position.
- `rho-ingress-telegram` validates history controls before turn lookup. The
  ingress test checks queued input after malformed and refused commands and
  retries a lost fork response with the original workspace, turn, variant and
  key after the conversation advances. Context preview uses the requesting
  speaker and selected Bot. Participation requires the observed message in the
  rendered recent window. Workers resolve their exact active turn. Candidate
  recovery uses the regeneration receipt, the returned variant, or matching
  edit lineage as appropriate. The tests cover a refused candidate watch and a
  lost response with an unrelated candidate in the deck.
- `rho-env` whole-line output limits now share one TypeScript implementation
  across `rho-web-tools`, `rho-acp-client` and `rho-t3`. Web fetch counts a
  final line terminator separately from the output window. Operator raw output
  and uploaded captures retain the full rendered text. T3 publishes the full
  report, keeps the inline result within the budget, and exposes model,
  worktree, branch, pending questions and any diff limitation in its summary.
  The T3 peer tests cover a multibyte report, omitted command output, an
  unavailable diff, and pending question options.

Live development Nexus at `http://localhost:3000` reproduced the default
turn-index page selecting the first turn of an idle conversation. With patched
source based on `ac2083b9118`, the scratch conversation's first turn was
`01a1ecb0-3021-70a3-964a-2658eed0acdd`. Target and result both selected the
second turn, `01a1ecb0-3070-7118-82c6-d0c026127d04`. Regeneration completed
on that turn as candidate `01a1ecb0-3ceb-75fe-87a5-840923e603fd`, which the
next result reported. The scratch workspace and conversation were removed.
The installed OpenCode service continued running on its existing build.

The runtime conformance gate, both runtime type checks and build, CLI and
Server adapter tests, and root `bun run check` passed. Telegram and T3 used
local protocol peers for integration coverage.

## Run reporting, session history and capture review, November 18, 2026

- `rho` one-shot runs stop their conversation when an unattended approval denial
  is refused. The result reports `needs_person` and counts confirmed denials.
  The conversation event feed supplies model switches and refusals from the
  accepted execution and its fallback variants. The print mode reports switches
  on stderr. `run.test.ts` exercises denial failure, a transient event-read
  failure, duplicate event delivery and an unrelated run.
- `rho-dev`, `rho-acp` and `rho-ingress-telegram` share selection of unresolved
  tasks for keyless retry and abandon, including model cost-limit holds.
  `operations.test.ts` exercises empty and ambiguous selections, the cost-limit
  exception and explicit task keys through the development extension.
- Bot history uses the current Nexus visibility rules and lists roots by
  recent activity. The shared command accepts `limit` from 1 to 100 and includes
  both active and archived conversations when `archived` is omitted. Telegram
  persists cursors and displayed conversation locations by chat and topic. A
  resumed update reuses its saved workspace, conversation and operation key.
  `telegram.test.ts` exercises the production ingress and Bot mutation owner.
- `rho-mcp` reads the selected server's prompt catalog during staging and probe
  through OpenCode's connected MCP client. A cached catalog can still be loading
  at that point. Tool results, prompts and resources share the media capture
  path. A capture names the local file and publishes the same bytes as a Nexus
  resource link. Empty text falls back to redacted structured content.
  `mcp.test.ts` and `mcp-session.test.ts` exercise curation, result mapping and
  the tool, prompt and resource paths against a loopback protocol peer.
- `rho-web-tools` reports a cross-site redirect encountered at the hop limit
  with its actionable destination. Overlong targets include the omitted byte
  count. `web.test.ts` exercises regular tool output and operator raw output.

The conformance gate covered the existing `rho-env` claims, filesystem and
terminal paths, native `rho-codemode` operations, `rho-browser` Chromium
actions, `rho-acp-client` stdio delegation and the `rho-t3` protocol peer.
The runtime build and both type checks, root check, CLI and Server adapters,
Protocol identifier check, 265 client tests and 76 Nexus UI bridge tests
passed. The three focused OpenCode MCP suites passed 169 tests. Client
artifacts were regenerated from the Protocol change.

Against development Nexus at `http://localhost:3000`, the patched source
paged active and archived Bot conversations and replayed a resume receipt.
The source runtime announced a loopback MCP prompt and completed a durable
MCP task whose PDF matched on disk and when downloaded from Nexus. It also
completed a Human-approved native Code Mode request with one bash execution.
The installed OpenCode service at `07241c7d0aa` independently verified one
bash execution, matching downloaded bytes and structured `false`. Temporary
workspaces, Bots, source Agents, MCP captures and local files were cleaned up.
Telegram and T3 verification used local protocol peers.

## Rebuilt installed-service verification, November 18, 2026

### Live development Nexus

The rebuilt OpenCode service and installed CLI (`v0.0.0-dev-202611180443`)
ran these checks against `http://localhost:3000`. The web and MCP checks
used loopback protocol peers with real Nexus runs and uploads.

- Bot history paginated across active and archived conversations and honored
  both explicit archive filters. Repeating a resume operation returned the
  original receipt.
- Keyless abandon selected the unresolved failure and skipped the absorbed
  failure. A subsequent keyless retry reported that no unresolved task
  remained.
- MCP discovered prompts and resources through the connected peer. Tool,
  prompt, and resource results each produced a local PDF and a Nexus upload
  that matched the fixture bytes. An empty text result exposed its structured
  content in the output as well as in the structured result.
- The web operator and runner reported the cross-site destination at the
  redirect hop limit. The operator output included the omitted byte count
  for an overlong destination.
- The installed one-shot CLI reported an unattended bash denial and returned
  the `model_switches` and `refusals` fields. The denied command did not write
  its scratch file. A separate Human-approved Code Mode request executed
  bash exactly once and retained structured `false` in the durable result.

The service remained ready with its original pairing and default workspace.
The temporary MCP and web settings were restored. Scratch workspaces, Bots,
captures, and local files were cleaned up.

### Fixture coverage

The focused suites passed 48 tests. `telegram.test.ts` exercised session
paging and resume recovery across an ingress restart. `run.test.ts` covered
a refused unattended denial and model-switch replay across a transient event
read failure. `operations.test.ts` covered the cost-limit exception and
ambiguous task repair. The earlier T3 verification used a local protocol peer.

## History, tool inputs and prompt preview, November 18, 2026

- `rho-ingress-telegram` history renders ten turns with stable IDs and a
  continuation command. Search includes archived conversations and scopes
  matches and cursors to the connection, chat and topic. Session switches
  remove unsubmitted work and unsent voice deliveries for that route. The
  durable cancellation receipts carry the original workspace and survive
  restart. `telegram.test.ts` covers the conversation workflow and resume.
- `rho-t3` returns an actionable tool error for incomplete work controls
  before reading a work record or calling the native service. `t3.test.ts`
  checks both boundaries with loopback peers.
- `rho-browser` fills editable controls using the existing Chromium session.
  `browser.test.ts` verifies text replacement, clearing, Enter submission,
  date input and refusal of a checkbox with real Chromium.
- `rho-env` reports a shell-quoted command for the oversized line in disk and
  editor reads. Input redirection supports leading dashes and works with both
  BSD and GNU sed. `runner.test.ts` and `editor-filesystem.test.ts` cover the
  original path, line and byte limit.
- `rho` and `rho-dev` share the input preparation used by `say` for the
  read-only prompt estimate. `dev.test.ts` checks default, remembered and
  explicit models, captured declarations, template variables, terminal and
  JSON output, and the absence of an admission write.

The full runtime gate exercised the existing application and executor, native
Code Mode, the web reader, browser, MCP, both ACP directions, Telegram, T3
and the development extension. The shared Code Mode suite passed 1,694 tests.
The focused Core MCP and OAuth suites passed 134 tests. Both runtime type
checks and build, the CLI and Server adapters, 76 Nexus UI bridge tests and
root `bun run check` passed.

An isolated managed service built from the patched checkout paired to
development Nexus at `http://localhost:3000`. Prompt preview rendered the
supplied text without admitting input. A Human approved a model-driven
Code Mode request and its nested bash call. A scratch counter recorded one
execution, and the model returned the UUID printed by bash. Telegram's history
formatter retrieved that answer from Nexus. Telegram transport and T3 used
local protocol peers. The scratch Agents, workspaces and files were removed.
The elected OpenCode service kept its existing pairing and default workspace.

## Conversation memory, Telegram queue, T3 and browser review

- `rho/test/memory_commands_projection_test.rb` maps to `memory-commands.ts`,
  `memory-commands.test.ts` and the runtime's `application.memory` adapter.
  Telegram and the management CLI share the SDK operations. A first write
  prepares an unallocated Speaker default under its owner, then verifies the
  same binding before writing. Existing documents retain the identity and
  version from the read. Conflicts surface without replay.
- `rho-ingress-telegram/test/queue_workflow_test.rb` maps to `telegram-ingress.ts`
  and `telegram.test.ts`. Numbered replies and their input IDs commit together.
  An older unscoped selection requests a new list. Status reads the bound
  conversation and queue without altering the numbered selection.
- `rho-t3/test/work_test.rb` maps to `t3.ts` and `t3.test.ts`. A new assignment
  accepts the catalog's model alias. Claim-key recovery uses the accepted
  selection and launch receipt. An explicit continuation retains the
  original work's model and provider.
- `rho-browser/test/tools_test.rb` and `session_popups_test.rb` map to
  `browser.ts`, `browser-session.ts` and `browser.test.ts`. A driver failure
  or browser deadline returns a tool error. A caller abort still cancels
  the call. Chromium tests verify tab replacement and surviving tabs.

Development Nexus verified first-write Speaker allocation, exact edit, grep
and stale-version refusal through the built runtime. The production Telegram
ingress used a loopback Telegram peer with a real Nexus Bot, conversation and
deferred inputs. Queue status, reordering, edit and cancellation after an
ingress restart all passed. The edit preserved the original delivery time.
Scratch documents, collections, conversations, queue inputs, Bots, workspaces
and Store entries were removed. The installed service remained ready. T3 used
an authenticated loopback peer.

The runtime conformance suite passed 376 tests and the shared Code Mode suite
passed 1,694. Both runtime type checks and the build passed. Client generation
ran from `packages/client`. The client, CLI, server and Protocol checks passed,
along with 404 Nexus UI unit tests and root `bun run check`. The source CLI
verified plain-text and JSON management output against a local HTTP peer.

### Rebuilt elected service

OpenCode `v0.0.0-dev-202611181546` verified all six conversation memory
commands against development Nexus. The installed CLI performed the first
Speaker write and printed plain text. The management API exercised exact
edit, grep, read, delete and JSON output. Nexus refused an update using
the previously observed revision.

The elected service temporarily used an authenticated loopback T3 peer.
A durable delegation resolved the model alias to its canonical ID, recovered
the dropped launch response and recorded one native launch after admission
replay. A conflicting continuation failed before it could dispatch. T3
configuration and publication returned to their original disabled state.

The production Telegram ingress ran separately with a loopback Telegram
peer and live Nexus. It listed deferred inputs, retained their numbered
selection across reordering and restart, preserved the due time on edit,
rescheduled the selected input and canceled the other one. The isolated
Chromium suite passed five tests covering browser failures, deadlines,
cancellation and tab ownership. Scratch workspaces and conversations
were removed, and the elected service remained ready.


## Agent renewal, executor artifacts, MCP, browser and development CLI

Reviewed against Rho `d15b55bdd`, starting from OpenCode `2572998b64ab`.

| Reference contract under `agents/rho` | TypeScript behavior and regression |
| --- | --- |
| `rho/lib/rho/renewal.rb` and `rho/lib/rho/daemon/{maintenance,lineage}.rb` | `renewal.ts` and `runtime.ts` check paired Agent OAuth credentials on startup and hourly, with a seven-day lead. Member and executor share the SDK rotation and a five-minute verification window for resource 401s. A successful rotation rebinds sockets and keeps the active executor. An unpublished rotation retains the live pair for SDK persistence. Lost authority retires the Agent and exposes pairing again. `runtime.test.ts` holds an accepted download across rotation, then exercises loss and re-pairing. `renewal.test.ts` covers publication recovery, concurrent refusals on both planes and socket authentication after rotation. The API-key and Human login suites exercise their separate owners. |
| `rho-env/lib/rho/env/tools/file_import.rb` and `rho-env/test/claim_attachments_test.rb` | `executor.ts` gives managed and reusable executors the same `storage/artifacts/<root hash>` default. `executor-library.test.ts` drives two HTTP claims with separate storage and project directories, checks an explicit artifact override and verifies the original file after a short second download. |
| `rho-mcp/lib/rho/mcp/curation.rb` and `rho-mcp/test/curation_test.rb` | Core exposes the original tool declarations alongside its normalized catalog. `mcp-session.test.ts` exercises a loopback HTTP peer that advertises `required: "path"`. Configured servers, imports by existing OpenCode server name, probes and editor mounts report the skipped tool. The valid sibling remains callable. Native OpenCode callers retain their normalized schema. |
| `rho-browser/test/tools_test.rb` | `browser-session.ts` checks visibility, effective enabled state and editability for fill. Clicks retain pointer hit-testing. `browser.test.ts` fills a covered input in isolated Chromium and verifies that a disabled fieldset and a read-only input receive no submission. |
| `rho-dev/lib/rho/dev/inspect.rb`, `rho-dev/test/dev_commands/inspection_test.rb` and `rho/lib/rho/cli/reporting.rb` | `dev/cli.ts` takes the installed channel’s elected URL and uses the SDK to verify its registration and private credential, including when the CLI configuration directory has a different password. `dev/terminal.ts` rejects branch-follow combinations before discovery, passes the initial page cursor and folds rounds, calls and progress with the SDK `ThreadAccumulator`. `dev.test.ts` runs the source CLI as a subprocess against an authenticated loopback service, checks mainline output and tests cost-limit and context-overflow guidance for unresolved model tasks. |

### Fixture and package verification

The runtime conformance gate passed **382 tests across 73 files** with isolated
Chromium, PTY and WebRTC. It exercised the six other owners through native Code
Mode child operations and approvals, web fetch rendering and captures, ACP editor
admission and replay, delegated ACP PDF forwarding and cancellation, Telegram
routing and durable delivery, and T3 assignment recovery. Optional transport
tests used local peers. The native Code Mode suite passed **1,694 tests across
46 files**. The affected Core MCP and integration suites passed **222 tests
across 11 files**. Both runtime type checkers, the runtime build
and root `bun run check` passed.

### Live development Nexus

- A runtime from the changed checkout paired a temporary Agent to
  `http://localhost:3000` and obtained a new workspace. Advancing its clock to
  seven days before expiry rotated both tokens through Nexus. The persisted
  rotation advanced once, the Agent, runner and workspace identities matched,
  and authenticated runner discovery and the development worker succeeded.
- A managed service started from the source checkout mounted and probed a
  loopback MCP server. Nexus advertised its valid tool, the probe reported the
  malformed sibling, and an actual Nexus executor claim returned the peer's text.
- The source CLI used the installed `opencode` executable and private
  authentication to list the scratch runner and followers on an isolated service
  with `nexus.dev` enabled. Its transcript follower read the completed mainline
  round of a real model run. The elected service also answered authenticated
  discovery and reported that its source-only extension was unloaded.
- The scratch credentials were revoked, the test workspaces and Agents were
  retired, and the isolated services were stopped. The elected service remained
  ready on its existing pairing.

## Replay, transcripts and tool output, November 19, 2026

| Rho package | TypeScript behavior and verification |
| --- | --- |
| `rho-ingress-telegram` | `telegram-ingress.ts` stages the original Telegram update, selected Bot, routing decision and receipt time in the physical Connection document before dispatch. Replay uses that Bot after a target change, holds the offset while its binding is missing, and clears the receipt in the same write that advances the offset. `telegram.test.ts` interrupts a schedule creation, verifies its original idempotency key on recovery, and checks positive and zero polling flood waits across restart. |
| `rho-t3` | `t3-transport.ts` validates all six adopted RPC methods before ticket discovery and requires the matching request ID for each exchange. `t3.test.ts` exercises malformed, failed and mismatched replies after launch, checks recovery through the native projection, and counts one launch across claim replay. It also covers bundled frames, caller cancellation and forwarding the worktree strategy. |
| `rho-dev` | `dev/terminal.ts` applies the watch deadline while waiting for the first run. `dev/streams.ts` counts missing events between each reader's cursors. Watch and follow restore text and reasoning from the SDK's byte-counted snapshots on overflow. `dev.test.ts` covers overlapping deltas and two readers sharing a WebSocket subscription with an oversized frame between retained frames. |
| `rho-env` | `runner.ts` and `bash-output.ts` format native OpenCode shell results. A silent nonzero exit now separates the output placeholder from the exit status with a blank line. Timeout results report the duration. `bash-output.test.ts` covers both cases with and without captured output. |
| `rho-web-tools` | `web.ts` reports the requested URL and HTTP reason phrase when a site answers with an error. It trims the excerpt, omits an empty body and retains the final URL in structured data. `web.test.ts` checks a redirected 404, a bounded 403 excerpt and a 300 with a body and no Location. |

The review also traced convention precedence in `rho`, child operations and
approvals in `rho-codemode`, tab ownership and input handling in `rho-browser`,
tool curation and readable media in `rho-mcp`, editor ingress and replay in
`rho-acp`, and delegated content and cancellation in `rho-acp-client`.
Their production owners and regression suites are listed in the
[reference contract table](#reference-contract-anchors).

The runtime gate passed **395 tests across 73 files** with Chromium, PTY and
WebRTC. Native Code Mode passed **1,694 tests across 46 files**. Both runtime
type checks, the runtime build and the repository's `bun run check` passed.

The built runtime used the elected service's development Nexus pairing at
`http://localhost:3000`. Telegram and T3 used loopback peers. An interrupted
Telegram acknowledgement left the original update in the Nexus Store. After
its target moved, the original Bot consumed it with one Telegram read.
Two-second and zero-second flood waits survived restart. T3 recovered a launch
whose peer returned failure after accepting it. Retrying the same assignment
returned the same completed work ID with one peer launch. The source CLI's
`watch` timed out on a scratch conversation with no run. The temporary profile
Store entries were removed and the development workspace was deleted.

## Conversation admission and tool verification, November 19, 2026

| Package | Reference and OpenCode behavior |
| --- | --- |
| `rho`, `rho-dev` | `rho/test/daemon/promptless_model_selection_test.rb` and `input_idempotency_test.rb` cover opening without an input and admitting prepared uploads. `application.open` records the requested route when the conversation is created. After restart, the first `say` inherits the explicit route and retains its configured fallbacks. The development CLI accepts attachment-only `do` and `say`, rejects input options on an empty open before creation, and reports a blocked admission with its reason. `test/dev.test.ts` exercises the CLI, application and SDK together. |
| `rho-browser` | `src/browser-session.ts` hit-tests the visible part of the element and maps that point into the Chromium session viewport for mouse dispatch. `test/browser.test.ts` clicks a fixed button wider than the viewport and checks its handler ran once. It also exercises covered controls and both same-origin and isolated frames. |
| `rho-mcp` | `rho-mcp/lib/rho/mcp/connection.rb` reads the advertised catalogs before publishing a connection. `src/mcp.ts` stages tools, prompts and resources together. A failed list releases the runtime's registration for that server and reports a redacted issue. `test/mcp-session.test.ts` checks both failing listing methods, probe results, and continued publication from a healthy sibling through OpenCode's MCP transport. |
| `rho-env` | `rho-env/lib/rho/env/tools/git_review.rb` preserves worktree names and bounds Git reads to ten seconds. `src/runner-git.ts` preserves trailing spaces, reports the deadline and missing executable as tool errors, and propagates caller cancellation. `test/git-review.test.ts` exercises path preservation, missing directories and cancellation. An isolated run also checked the missing executable and the real ten-second deadline. |

Against development Nexus, a promptless open created zero inputs and zero turns.
A new application instance submitted a scheduled attachment-only input to the
same conversation. Its frozen admission retained `deepseek/deepseek-v4-pro`
over the `deepseek/deepseek-flash` default, and the downloaded attachment
matched all 25 bytes. The scheduled input, admission record, scratch workspace
and upload were removed after verification.

The runtime conformance suite passed 397 tests in 73 files with Chromium, PTY
and WebRTC. The native Code Mode suite passed 1,694 tests. The runtime build,
both runtime type checks, the Nexus CLI and experimental identifier tests, and
the repository's `bun run check` also passed.

## Schedule recovery, host routing and tool output, November 19, 2026

| Rho reference contract | TypeScript owner | Local regression |
| --- | --- | --- |
| `rho-ingress-telegram/lib/rho/ingress-telegram/runtime.rb` and `schedule_workflow.rb` freeze relative rules and creation policy and bound replay by the Telegram message date. | `src/telegram-ingress.ts`, `src/telegram-schedules.ts`, `src/telegram-state.ts` | `test/telegram.test.ts` restarts after a lost creation response, changes the Bot's current conversation, counts submissions on both sides of the receipt cutoff and redelivers the acknowledged update. A valid first `/job create` or `/remind` opens one conversation through `bot.current`. Invalid commands open none. |
| `rho/lib/rho/host.rb` and `extensions/ops/run_routes/following.rb`, with `rho-dev/lib/rho/dev/conversations.rb` and `runs.rb`, route compaction and attachment by the addressed host. | `dev/terminal.ts` dispatches to `src/operations.ts` or `dev/streams.ts`. | `test/dev.test.ts` checks the exact SDK compaction route, refusal before either invalid write, and conversation adoption. `test/dev-worker.test.ts` attaches a run through the CLI and observes its follower through the extension worker and loopback WebSocket. |
| `rho-codemode/lib/rho/codemode/runtime.js` emits named resource links. Nexus accepts links to observed artifacts. | `src/code.ts` implements `resource()` in OpenCode Code Mode. | `test/code.test.ts` forwards both names observed for one URI through the native interpreter and rejects an absent or blank name and mismatched metadata. |
| `rho-web-tools/lib/rho/web-tools/render.rb` removes discarded subtrees before reading the document title. | `src/web.ts` selects the first surviving title and passes the body to OpenCode's HTML-to-Markdown converter. | `test/web.test.ts` fetches a loopback HTML page with template, SVG and duplicate titles and checks both the decoded title and the Markdown body. |

### Development Nexus

The changed runtime used the elected service's pairing with `http://localhost:3000`
and a private workspace. A loopback peer supplied Telegram identity and command
registration. The test clock controlled recovery age. Each initial schedule POST
reached Nexus and committed before its response was discarded.

| Recovery age | Schedule POSTs including the original | Observed result after restart and redelivery |
| --- | --- | --- |
| 86,399 seconds | 2 | Both POSTs had the same path, key, policy and rule. Nexus returned the same ID and listed one matching schedule. The runtime queued one success notice. |
| 86,400 seconds | 1 | Nexus listed one matching schedule. The runtime advanced the Connection offset and queued one notice directing the requester to `/job list`. |

The native Code Mode binding observed two names for one real 51-byte Nexus
upload and forwarded the first link. A member resolved a run task with that
output. Nexus returned the selected name and URI on the completed task, and the
downloaded bytes matched the original. The verification Bot, profile Store
entries, ingress speaker, conversation, schedules, run and upload were removed
and the scratch workspace was deleted.

The runtime suite passed **403 tests across 73 files**, including the existing
`rho-env`, `rho-browser`, `rho-mcp`, `rho-acp`, `rho-acp-client` and `rho-t3`
suites with Chromium, PTY and WebRTC enabled. Native Code Mode passed **1,694
tests across 46 files**. Both runtime type checkers, the runtime build and the
root `bun run check` passed.

## Rewind, regeneration and project skills, November 19, 2026

| Reference contract | TypeScript behavior | Regression coverage |
| --- | --- | --- |
| `rho/lib/rho/extensions/ops.rb` and `rho/test/extensions/ops_restore_guard_test.rb` | `src/operations.ts` refuses ordinary rewind on a Bot and refuses fresh history mutations during an active turn. `src/environments.ts` checks managed processes in the conversation's current local root before a fork, then checks the root recorded by each local checkpoint before restoration. Checkpoint lookup and restore use the original runner and the member's author approval rules. | `test/operations.test.ts` and `test/restore-operations.test.ts` cover zero writes on preflight refusal, a process in a nested directory, a moved root, checkpoint lookup by run, independent remote restoration, explicit keep, undo and file contents. |
| `rho/test/core_execution_selection_test.rb` and `rho-dev/lib/rho/dev/conversations.rb` | `src/operations.ts` forwards the requested model selection and fallback list. An accepted key skips restoration and asks Nexus to verify the submitted intent. `dev/terminal.ts` shows the forked conversation or regenerated variant, each runner's result and its undo checkpoint, including when Nexus subsequently refuses regeneration. | `test/operations.test.ts`, `test/dev.test.ts` and `test/restore-operations.test.ts` check omitted fields, an explicit empty list, receipt replay, partial restoration and a conflict after restoration. |
| `rho/lib/rho/extensions/ops/skill_routes.rb` and `rho-dev/lib/rho/dev/skills.rb` | `src/operation-skills.ts` reports the runner's announced documents alongside agent and workspace skills. `dev/terminal.ts` distinguishes an unbound runner, a bound root with zero documents and a populated project. | `test/dev.test.ts` exercises the operation and both CLI output formats. |

At the time of this check, Nexus limited Run creation keys to 36 bytes and the
runtime shortened the SDK's checkpoint keys to 32 hexadecimal characters.
Nexus now accepts up to 255 bytes. The runtime uses the SDK's full SHA-256 keys
for lookup and restore, and the restore fixture checks their stability on retry.

Against development Nexus, the source runtime used a private scratch workspace
and the installed OpenCode executor at `4a4a878482154d99ad7363edd7c493b8ce60a681`.
A Bot kept its selected conversation. An active turn and a process in the
current root each prevented a fork. After the root moved, rewind returned a
child with `process_live`, and regeneration stopped before submission. After
the process stopped, the executor restored all 44 original bytes and returned
an undo checkpoint. A fresh regeneration restored first. Repeating its key and
intent returned the same variant without another runner call. Changing the
empty fallback list returned `idempotency_envelope_mismatch`. Project skills
included the document announced from the scratch root. The scratch workspace,
Bot records and local files were removed.

The runtime conformance suite passed **406 tests across 74 files** with
Chromium, PTY and WebRTC. Native Code Mode passed **1,694 tests**. Both runtime
type checkers, the runtime build, the Nexus CLI and experimental identifier
tests, and the repository's `bun run check` passed.

## Scoped MCP, ACP and development controls, November 21, 2026

| Reference contract | TypeScript owner and verification |
| --- | --- |
| `rho-mcp/test/stdio_transport_test.rb` and `rho-env/lib/rho/env/child_env.rb` | `src/mcp.ts` uses a scoped OpenCode MCP registration with a replacement environment. The stdio child inherits ordinary launch settings, omits runtime and credential variables, and receives its explicit variables. `test/mcp-session.test.ts` exercises configured, probed and ACP-supplied rows with a real child and checks probe retirement. Core's `mcp-stdio.test.ts` checks that private stderr is drained and kept out of exit diagnostics. |
| `rho-env/lib/rho/env/secrets.rb`, `rho-mcp/test/settings_test.rb` and `rho-acp-client/lib/rho/acp-client/capture.rb` | `src/integration-secrets.ts` shares single-pass substitution, empty-variable refusal and the eight-byte redaction floor. MCP resolves `~` through OpenCode's path resolver. ACP capture masks keys and values before publication. Settings and live child fixtures exercise those boundaries. |
| `rho-browser/lib/rho/browser/tools/base.rb` | Shared browser input trims the opaque reference before dispatch. The Chromium regression exercises padded references for click and type, then verifies that the old reference still expires. |
| `rho-dev/test/dev_commands/execution_test.rb` and `stream_test.rb` | The CLI reports saved, already-held and refused grants. A refusal keeps the approved task receipt and exits with status 1. Phase reports show the current phase, background delivery and spend, and expose the SDK response through `--json`. `test/dev.test.ts` drives the CLI through shared operations and a loopback API fixture. |

The package-wide gate exercises application admission and recovery, executor
ownership and filesystem/terminal claims, native Code Mode, web fetch and
Chromium, MCP and ACP peers, Telegram and T3 protocol fixtures, and the
source-only development controls. Runtime conformance passed 413 tests across
76 files with Chromium, PTY and WebRTC. The selected Core MCP and Integration
suites passed 141 tests. The Code Mode suite, CLI and Server Nexus adapter
tests, Protocol experimental-identifier test, affected TypeScript checks,
runtime build and root `bun run check` passed. The WebUI reference diff contains
only Ruby lockfile changes.

Development Nexus started on loopback and returned HTTP 200 from `/up`.
Using the existing pairing and a read-only run, the source development CLI
rendered real phase and spend data and returned the structured phase report
with `--json`.

## Model adaptations and declaration policy, November 21, 2026

| Rho reference contract | OpenCode behavior and evidence |
| --- | --- |
| `rho/test/adaptations_test.rb` and the SDK model-adaptation rows | New declarations resolve the current Codex, Claude and Kimi references across direct, subscription and broker lanes. Retired IDs use the default row under automatic adaptations. Local rows retain their precedence and reject a repeated pattern within one source. `adaptations.test.ts` covers both current and retired references, local precedence and duplicate patterns. |
| `rho/lib/rho/adaptations.rb`, `role_declarations.rb` and `daemon/host_followers/bindings.rb` | The served skill spelling is deferred while discovery remains available. Presets apply published-role parameters to the plain and adapted spawn spellings, including child roles. Subagent off excludes conversation requests and delegation from new app, Side and Bot work. The image kernel tool enters the declaration only when its enabled extension has a model. Adaptation, Preset, Side and runtime fixtures exercise these declarations and settings transitions. |
| `rho/test/daemon/configuration_test.rb` and the Rho profile and Preset compilers | Profiles, conversation and role declarations, Bots and registered agents compile the summary prompt from their compaction policy. Runner refreshes and approval grants preserve the prompt during complete profile writes. Disabling adaptations or compaction clears it. Bot creation retries keep the original prompt, and admitted work retains its frozen declaration. Runtime, Preset, Bot and registered-agent fixtures cover these paths. |

The authenticated read-only assembly endpoint on development Nexus accepted the
compiled Kimi, Claude and Codex declarations. It returned one deferred skill
entry for each, kept `tool_search` and `tool_call` available, preserved
`request` and `links`, and lowered `spawn` or `spawn_agent` to the published-role
parameter. The development account lacked those model routes for inference, so
model selection was exercised through the runtime conformance suite.

Runtime conformance passed 415 tests across 76 files with Chromium, PTY and
WebRTC. Both runtime type checkers, the runtime build, the CLI and Server Nexus
adapter tests, the Protocol identifier check, and the repository's
`bun run check` passed.

## Turn pagination, candidate controls and directory listings

The November 21 review checked the production owners and test anchors above for
all eleven executable non-WebUI packages. Cybros revisions `a91c63f44` and
`47209fd60` share the same `agents/rho` tree, `3da8e3ef9`.

| Reference test | TypeScript behavior and regression |
| --- | --- |
| `rho/test/extensions/ops_history_test.rb` and `rho-dev/test/dev_commands/conversations_test.rb` | `operations.ts` collects up to ten forward pages of 100 turns and preserves a single reverse window. `dev/terminal.ts` prints the active run, full reply, originating prompt and exclusive continuation. `dev.test.ts` exercises the CLI in text and JSON modes at the page boundary, at the cap and past the final turn. |
| `rho-ingress-telegram/test/conversation_workflow_test.rb` | `/variants` identifies the active candidate and bounds each preview. The command and recovery paths persist the same variant, run, requester, route and source message before acknowledging a run-backed candidate. `telegram.test.ts` exercises immediate status and stop after restart, the original task ID, editing, reselection and a lost regeneration response. |
| `rho-env/test/tools/ls_test.rb` | `runner-list.ts` passes the original bytes to the filesystem and decodes names for display. The Linux case in `runner.test.ts` checks an invalid UTF-8 directory name, its directory suffix and a valid sibling. |
| `rho-webui/test/schedules_test.js` | The WebUI owns schedule editing. OpenCode's management protocol accepts sparse updates with the observed lock version. `runtime.test.ts` checks the exact prompt-only body sent through the Cybros SDK. The [UI ledger](../nexus-ui/docs/rho-webui-parity.md) covers form behavior. |

Runtime conformance passed 418 tests on macOS with Chromium, WebRTC and PTYs.
The Linux-only filename regression passed on Ubuntu. Both runtime type checks,
the runtime build, the CLI and Server Nexus tests, the Protocol identifier test
and root `bun run check` passed. Native Code Mode passed 325 tests and the Core
integration and credential-refresh suites passed 20.

On development Nexus, an isolated runtime with the source development extension
printed a real turn and used its continuation to return the next turn as JSON.
The source UI management bridge updated only the prompt of a scheduled job,
retained its exact clock, model, name and approval mode, and received HTTP 409 for
a stale lock version. The temporary schedules were canceled, workspaces deleted
and agents removed.

## Preset tool selection, ACP capture and T3 setup

Reviewed November 21, 2026 against Cybros `42a2ecb2c`. Its `agents/rho` tree
is identical to the previous pin (`3da8e3ef910652ade18aea35a0ff7ba5601b3692`).
The application and executor tables above identify the reference contracts and
their tests. This pass traced the following production entry points.

| Rho package | OpenCode entry point and owner |
| --- | --- |
| `rho` | The managed server's experimental Nexus handlers call `runtime.ts`. Preset commands, Bot settings and conversation admission go through `presets.ts`, `bots.ts` and `application.ts`. |
| `rho-env` | The connected executor drains announced work through `runner-inbox.ts`, placement checks and the tool implementations in `runner.ts`. |
| `rho-codemode` | The `nexus.codemode` extension exposes `code` through the runner. `code.ts` uses OpenCode Code Mode and the claim's operation interface. |
| `rho-mcp` | `nexus.mcp` registers OpenCode MCP transports through `mcp.ts`. Their announcements feed `preset-mcp.ts`. |
| `rho-web-tools` | The built-in web extension registers `web_fetch` and `web.fetch`, both backed by `web.ts`. |
| `rho-browser` | `nexus.browser` registers browser tools. `browser.ts` and `browser-session.ts` own tab state and actions. |
| `rho-acp` | The CLI Nexus ACP adapter loads the editor entry point in `editor.ts` and uses the service's authenticated conversation operations. |
| `rho-acp-client` | `nexus.acp-client` registers `delegate_agent` and the `acp.*` management commands in `acp.ts`. |
| `rho-ingress-telegram` | The Telegram extension routes updates and operator commands through the ingress, transport and worker modules. |
| `rho-t3` | `nexus.t3` registers setup commands and coding tools backed by `T3Client`, `T3Transport` and `T3Catalog`. |
| `rho-dev` | `dev/cli.ts` talks to the managed service. The opt-in `dev/extension.ts` command dispatches to the shared operations and streams. |

### Fixture verification

- `runtime.test.ts` and `application.test.ts` exercise a callable name through
  Preset replacement, profile publication and input admission. The role keeps
  its own canonical selection. A subsequent edit affects fresh work, and a
  replay carries the original declaration.
- `policy.test.ts` checks distinct executor and Nexus MCP connections offering
  the same remote tool, member-ID exclusions from earlier versions, and an
  explicitly named Nexus import. `bots.test.ts` checks that a Bot pins its
  Preset until the operator selects another.
- `acp.test.ts` parses the complete JSONL from an active and retired child
  across the former 65,536-character cutoff. Capture still enforces the
  16 MiB limit and applies the existing redaction and PDF metadata rules.
- `t3.test.ts` counts peer requests. Invalid paths make zero requests, a
  truncated POST response triggers a directory read, and adopting the trimmed
  path a second time avoids another create.
- Runtime conformance with Chromium passed 421 tests across 76 files. The
  Linux-only filename test was skipped on macOS. Both runtime type checks, the runtime
  build, CLI and Server Nexus adapter tests, Protocol identifier tests, and root
  `bun run check` passed. The OpenCode client was regenerated from the updated
  management command. The checked-in Cybros SDK serviced the live calls.

### Development Nexus verification

An isolated source-built managed service and scratch Agent connected to
`http://localhost:3000`. The production UI saved a Main Preset with
`tools: ["memory_read"]` and an empty runner selection. Nexus reported
`kernel_tools: ["nexus.memory.read"]` on the profile and assembled exactly
`memory_read`. Input `01a1fe10-27cc-71af-95d1-e97db8ad90b4` had the same
canonical declaration and callable allowlist in the durable admission journal.
A scratch Bot using the same selection also published `nexus.memory.read`.
Removing its selected Preset returned HTTP 400 and named the Bot.

Two isolated stdio MCP peers advertised `read`, one on the Agent role and one
on the runner role. The UI saved two separate exclusions with the announced
executor ID. A real conversation-owned `delegate_agent` task produced 73,497
characters across eight complete JSONL records. The active capture included
initialization and the retired capture retained the entire prefix. An isolated
HTTP/WebSocket T3 peer accepted one create, lost the response and returned
the new project on directory reconciliation. The saved project and default
coding agent survived UI reload. The live form also exposed a bridge mismatch
that hid the runtime's path refusal. The browser regression also reproduced
a failed project listing hiding a successful agent listing. The UI now
retains each result independently.

The scratch integrations were disabled, the workspace reached `deleted`,
the Agent reached `removed` and both issued keys were revoked. Nexus retains
the ACP transcript with its deleted workspace's execution records. The
installed service was ready on its original pairing after cleanup.
