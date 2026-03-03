export const normalizeWheelDelta = (input: { deltaY: number; deltaMode: number; rootHeight: number }) => {
  if (input.deltaMode === 1) return input.deltaY * 40
  if (input.deltaMode === 2) return input.deltaY * input.rootHeight
  return input.deltaY
}

export const shouldMarkBoundaryGesture = (input: {
  delta: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  mode?: "reversed" | "normal"
}) => {
  const max = input.scrollHeight - input.clientHeight
  if (max <= 1) return true
  if (!input.delta) return false

  const mode = input.mode ?? "reversed"
  if (mode === "normal") {
    const top = Math.max(0, Math.min(max, input.scrollTop))
    if (input.delta < 0) return -input.delta > top
    const bottom = max - top
    return input.delta > bottom
  }

  const top = max + Math.max(-max, Math.min(0, input.scrollTop))
  if (input.delta < 0) return -input.delta > top
  const bottom = -Math.max(-max, Math.min(0, input.scrollTop))
  return input.delta > bottom
}
