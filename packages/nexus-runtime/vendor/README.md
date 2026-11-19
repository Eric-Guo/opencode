The archive is the MIT-licensed public SDK from cybros.ai2 revision
`12399bf520f2063e569f264580b7b1be5f25f38c`, built in `sdks/typescript` with
`pnpm run build` and packed with `npm pack --ignore-scripts`. The package includes
its upstream license. Both the runtime and the Nexus desktop bridge consume this archive.

The runtime applies a Bun patch to the SDK's checkpoint helper. Nexus accepts
run creation keys up to 36 bytes. The helper uses the first 16 bytes of its
SHA-256 digest as 32 hexadecimal characters so a retried lookup or restore
reuses the same run. The packed runtime bundles the patched SDK.
