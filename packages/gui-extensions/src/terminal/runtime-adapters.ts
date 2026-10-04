type RecordValue = Record<string, unknown>

const isRecord = (value: unknown): value is RecordValue => {
  return typeof value === "object" && value !== null
}

const isDisposable = (value: unknown): value is { dispose: () => void } => {
  return isRecord(value) && typeof value.dispose === "function"
}

export const disposeIfDisposable = (value: unknown) => {
  if (!isDisposable(value)) return
  value.dispose()
}

// SAFETY: Ghostty's runtime options API accepts the option-specific values passed by the typed terminal owner.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const hasSetOption = (value: unknown): value is { setOption: (key: string, next: unknown) => void } => {
  return isRecord(value) && typeof value.setOption === "function"
}

// SAFETY: This adapter probes Ghostty's optional options API before forwarding the owning terminal's options.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const setOptionIfSupported = (value: unknown, key: string, next: unknown) => {
  if (!hasSetOption(value)) return
  value.setOption(key, next)
}

// SAFETY: Ghostty keeps hover metadata private; this compatibility boundary verifies the record and text before returning it.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const getHoveredLinkText = (value: unknown) => {
  if (!isRecord(value)) return
  const link = value.currentHoveredLink

  if (!isRecord(link)) return

  if (typeof link.text !== "string") return

  return link.text
}
