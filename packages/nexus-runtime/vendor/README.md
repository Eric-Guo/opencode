The runtime and desktop bridge use the MIT-licensed `@cybros/agent` SDK
from `sdks/typescript` in Cybros revision `e2033ac9a` (post lean-kernel
refactor). This revision adds the triggers, thread-subscription and outbox
resources (including lease-claim and settlement), platform user cost limits,
`remaining_ms` on claims, `ice_servers` on task realtime projections,
`include_tool_outputs` on history, `MemorySelection.mode`, the `tool_name`
run filter and the tightened disposition/enum wire shapes. It removes the
retired budget-ledger resources. `UpdateSchedule.name` can still be cleared
with null.
Build that source with `pnpm run build`, run `npm pack --ignore-scripts`,
and rename the output to `cybros-agent-0.1.0-superagent.tgz`.
The filename distinguishes the archive in Bun's installation cache.
The upstream license is included.

The packed runtime bundles this SDK directly. Its checkpoint helper sends a
64-character SHA-256 key for each lookup or restore. It requires a Nexus server
that accepts full-length keys on Run creation.

When updating a checkout that used the SDK patch, run
`bun install --force --frozen-lockfile` from the repository root. A regular
install can reuse the previously patched copy from `node_modules`.
