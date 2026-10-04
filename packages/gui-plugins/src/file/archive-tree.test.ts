import { expect, test } from "bun:test"
import { archiveRows, archiveTree } from "./archive-tree"

test("archive names preserve duplicates, implicit parents, and literal unsafe-looking paths", () => {
  const tree = archiveTree(
    ["中文/a.txt", "中文/a.txt", "中文/", "../host", "/absolute", "a\\b", "中文/nested/b.txt"].map((name, id) => ({
      id,
      name,
      directory: name.endsWith("/"),
      size: 10,
      compressedSize: 5,
      encrypted: false,
      symlink: false,
      compressionMethod: 0,
    })),
  )

  const directory = tree.children.find((node) => node.name === "中文")

  expect(tree.count).toBe(7)
  expect(tree.size).toBe(60)
  expect(directory?.count).toBe(4)
  expect(directory?.size).toBe(30)
  expect(directory?.children.filter((node) => node.name === "a.txt").map((node) => node.id)).toEqual([
    "entry:0",
    "entry:1",
  ])
  expect(directory?.children.filter((node) => node.name === "a.txt").every((node) => node.duplicate)).toBe(true)
  expect(
    tree.children
      .filter((node) => !node.directory)
      .map((node) => node.name)
      .sort(),
  ).toEqual(["../host", "/absolute", "a\\b"].sort())
  expect(archiveRows(tree, new Set(), "b.txt").map((row) => row.node.name)).toEqual(["中文", "nested", "b.txt"])
  expect(archiveRows(tree, new Set(), "missing")).toEqual([])
})
