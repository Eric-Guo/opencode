export {}

// OpenSSH invokes the desktop executable directly. Handle prompts before loading
// application lifecycle code, acquiring its single-instance lock, or starting a sidecar.
if (process.env.OPENCODE_SSH_ASKPASS_PORT) {
  const { NodeServices } = await import("@effect/platform-node")
  const { Effect } = await import("effect")
  const { askpass } = await import("./ssh/askpass-client")
  process.exit(await Effect.runPromise(askpass.pipe(Effect.provide(NodeServices.layer))))
}

const { app } = await import("electron")
const { acquireApplicationLock, configureApplication } = await import("./lifecycle/configure")
const { createEarlyWindow } = await import("./windows/early")
const { registerRendererScheme } = await import("./windows/scheme")

// This module stays small on purpose. Electron holds the ready event until the entry module has
// finished, and the first window should be on screen before the rest of the main process — a few
// hundred milliseconds of module evaluation and layers — loads. Configuration and the scheme must
// precede ready; the window is created the moment ready fires; everything else is imported after.
configureApplication()
if (acquireApplicationLock()) {
  registerRendererScheme()
  // Window first, then the bundle: starting the import before ready delays ready itself, because the
  // module graph evaluates on the same thread Chromium needs to finish initialising.
  void app.whenReady().then(() => {
    createEarlyWindow()
    return import("./desktop")
  })
}
