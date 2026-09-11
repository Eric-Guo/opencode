export {}

// OpenSSH invokes the desktop executable directly. Handle prompts before loading
// application lifecycle code, acquiring its single-instance lock, or starting a sidecar.
if (process.env.OPENCODE_SSH_ASKPASS_PORT) {
  const { NodeServices } = await import("@effect/platform-node")
  const { Effect } = await import("effect")
  const { askpass } = await import("./ssh/askpass-client")
  process.exit(await Effect.runPromise(askpass.pipe(Effect.provide(NodeServices.layer))))
}

await import("./desktop")
