const nativeAgentIDs = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"])

export function isNativeAgentID(id: string) {
  return nativeAgentIDs.has(id)
}

export function hasCustomAgent(items: Array<{ name: string; native?: boolean }>) {
  return items.some((item) => item.native === false || (item.native === undefined && !isNativeAgentID(item.name)))
}

export function selectableAgents<T extends { name: string; mode: string; hidden?: boolean }>(
  items: T[],
  hidden: readonly string[],
) {
  const names = new Set(hidden)
  return items.filter((item) => item.mode !== "subagent" && !item.hidden && !names.has(item.name))
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}
