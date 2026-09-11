export * as KimiEnvironment from "./kimi-environment.js"

export function name(index: number) {
  return index === 0 ? "KIMI_API_KEY" : `KIMI_API_KEY_${index + 1}`
}

export function isName(value: string) {
  return /^KIMI_API_KEY(?:_(?:[2-9]|[1-9]\d+))?$/.test(value)
}

export function names() {
  return [...new Set([name(0), ...Object.keys(process.env).filter(isName)])].toSorted((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )
}
