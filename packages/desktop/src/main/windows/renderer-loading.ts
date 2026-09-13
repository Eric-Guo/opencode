/** Defer initial loads until the extension has identified its primary renderer. */
export function createRendererLoader<T>(failed: (error: unknown) => void) {
  const pending = new Map<T, () => Promise<void>>()
  let ready = false
  return {
    add(contents: T, load: () => Promise<void>) {
      if (!ready) {
        pending.set(contents, load)
        return
      }
      void load().catch(failed)
    },
    primary(contents: T) {
      ready = true
      const load = pending.get(contents)
      pending.delete(contents)
      pending.forEach((load) => void load().catch(failed))
      pending.clear()
      return load
    },
  }
}
