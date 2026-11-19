The archive is the MIT-licensed public SDK from cybros.ai2 revision
`12399bf520f2063e569f264580b7b1be5f25f38c`, built in `sdks/typescript` with
`pnpm run build` and packed with `npm pack --ignore-scripts`. The package includes
its upstream license. Both the runtime and the Nexus desktop bridge consume this archive.

The packed runtime bundles this SDK directly. Its checkpoint helper sends a
64-character SHA-256 key for each lookup or restore. It requires a Nexus server
that accepts full-length keys on Run creation.

When updating a checkout that used the SDK patch, run
`bun install --force --frozen-lockfile` from the repository root. A regular
install can reuse the previously patched copy from `node_modules`.
