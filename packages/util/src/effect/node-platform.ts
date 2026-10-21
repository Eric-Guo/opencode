// Keep these deep imports: the full platform barrel loads undici, ioredis,
// and node:sqlite, which runtimes such as workerd cannot load.
export * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
export * as NodePath from "@effect/platform-node/NodePath"
