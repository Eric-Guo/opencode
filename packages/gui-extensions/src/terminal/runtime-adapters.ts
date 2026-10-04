import { Predicate } from "effect"

const isDisposable = (value: unknown): value is { dispose: () => void } => {
  return Predicate.isObject(value) && "dispose" in value && Predicate.isFunction(value.dispose)
}

// SAFETY: Ghostty addon registrations have version-dependent disposal handles; this boundary checks dispose before calling.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const disposeIfDisposable = (value: unknown) => {
  if (!isDisposable(value)) return
  value.dispose()
}

// SAFETY: Ghostty's runtime options API accepts the option-specific values passed by the typed terminal owner.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const hasSetOption = (value: unknown): value is { setOption: (key: string, next: unknown) => void } => {
  return Predicate.isObject(value) && "setOption" in value && Predicate.isFunction(value.setOption)
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
  if (!Predicate.isObject(value) || !("currentHoveredLink" in value)) return
  const link = value.currentHoveredLink

  if (!Predicate.isObject(link) || !("text" in link)) return

  if (!Predicate.isString(link.text)) return

  return link.text
}
