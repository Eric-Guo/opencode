import type { FileSystem } from "@opencode/schema/filesystem"

export type ArchiveNode = {
  id: string
  name: string
  path: string
  directory: boolean
  entries: FileSystem.ArchiveEntry[]
  children: ArchiveNode[]
  size: number
  count: number
  duplicate: boolean
}

/** Archive names stay display strings; never normalize them as host paths. */
export function archiveTree(entries: readonly FileSystem.ArchiveEntry[]) {
  const root: ArchiveNode = {
    id: "root",
    name: "",
    path: "",
    directory: true,
    entries: [],
    children: [],
    size: 0,
    count: 0,
    duplicate: false,
  }

  const directories = new Map<string, ArchiveNode>([["", root]])
  const names = new Map<string, number>()

  entries.forEach((entry) => names.set(entry.name, (names.get(entry.name) ?? 0) + 1))
  entries.forEach((entry) => {
    const parts = (entry.directory ? entry.name.replace(/\/$/, "") : entry.name).split("/")

    // Unusual names are shown verbatim at the root, without inferring filesystem semantics.
    const literal =
      entry.name.includes("\\") ||
      parts.some((part) => !part || part === "." || part === "..") ||
      /^[a-z]:/i.test(entry.name)

    const segments = literal ? [entry.name] : parts

    const parent = segments.slice(0, -1).reduce((parent, name, index) => {
      const path = segments.slice(0, index + 1).join("/")
      const existing = directories.get(path)

      if (existing) return existing

      const node: ArchiveNode = {
        id: `directory:${path}`,
        name,
        path,
        directory: true,
        entries: [],
        children: [],
        size: 0,
        count: 0,
        duplicate: false,
      }

      parent.children.push(node)
      directories.set(path, node)

      return node
    }, root)

    const path = segments.join("/")
    const existing = entry.directory && !literal ? directories.get(path) : undefined

    if (existing) {
      existing.entries.push(entry)
      existing.duplicate = (names.get(entry.name) ?? 0) > 1

      return
    }

    const node: ArchiveNode = {
      id: entry.directory && !literal ? `directory:${path}` : `entry:${entry.id}`,
      name: segments.at(-1) ?? entry.name,
      path,
      directory: entry.directory,
      entries: [entry],
      children: [],
      size: entry.directory ? 0 : entry.size,
      count: 1,
      duplicate: (names.get(entry.name) ?? 0) > 1,
    }

    parent.children.push(node)

    if (entry.directory && !literal) directories.set(path, node)
  })

  const finish = (node: ArchiveNode) => {
    node.children.forEach(finish)
    node.children.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))

    if (!node.directory) return

    node.count = node.entries.length + node.children.reduce((count, child) => count + child.count, 0)
    node.size = node.children.reduce((size, child) => size + child.size, 0)
  }

  finish(root)

  return root
}

export function archiveRows(root: ArchiveNode, expanded: ReadonlySet<string>, search: string) {
  const query = search.trim().toLowerCase()

  const visit = (node: ArchiveNode, level: number): { node: ArchiveNode; level: number }[] => {
    const children = query || expanded.has(node.id) ? node.children.flatMap((child) => visit(child, level + 1)) : []

    if (query && !node.path.toLowerCase().includes(query) && children.length === 0) return []

    return [{ node, level }, ...children]
  }

  return root.children.flatMap((node) => visit(node, 0))
}
