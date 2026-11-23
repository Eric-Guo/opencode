The runtime and desktop bridge use the MIT-licensed `@cybros/agent` SDK
from `sdks/typescript` in Cybros revision `0dac9b6b09758458379b06c8d80790f4dd035deb`,
which adds the lifecycle selector on `RealtimeClient.inferenceEvents`.
Build that source with `pnpm run build`, run `npm pack --ignore-scripts`,
and rename the output to `cybros-agent-0.1.0-lifecycle.tgz`.
The filename distinguishes the archive in Bun's installation cache.
The upstream license is included.

The packed runtime bundles this SDK directly. Its checkpoint helper sends a
64-character SHA-256 key for each lookup or restore. It requires a Nexus server
that accepts full-length keys on Run creation.

When updating a checkout that used the SDK patch, run
`bun install --force --frozen-lockfile` from the repository root. A regular
install can reuse the previously patched copy from `node_modules`.
