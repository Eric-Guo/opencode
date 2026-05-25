import { describe, expect, test } from "bun:test"
import { normalize, resolveFileDiff, text } from "./session-diff"

describe("session diff", () => {
  test("keeps unified patch content", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toBe(diff.patch)
    expect(view.fileDiff.name).toBe("a.ts")
    expect(text(view, "deletions")).toBe("one\ntwo\n")
    expect(text(view, "additions")).toBe("one\nthree\n")
  })

  test("keeps missing final newlines from unified patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+three\n\\ No newline at end of file\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(text(view, "deletions")).toBe("one\ntwo")
    expect(text(view, "additions")).toBe("one\nthree")
  })

  test("keeps separated patch hunks partial without complete file contents", () => {
    const fileDiff = resolveFileDiff({
      file: "project.ts",
      patch:
        'Index: project.ts\n===================================================================\n--- project.ts\t\n+++ project.ts\t\n@@ -1,3 +1,2 @@\n import { and } from "drizzle-orm"\n-import { sql } from "drizzle-orm"\n import { ProjectTable } from "./project.sql"\n@@ -346,3 +345,3 @@\n import { Database } from "@/storage/db"\n-import { ProjectTable } from "./project.sql"\n+import { ProjectTable } from "../project/project.sql"\n import { SessionTable } from "../session/session.sql"\n',
    })

    expect(fileDiff.isPartial).toBe(true)
    expect(fileDiff.hunks).toHaveLength(2)
    expect(fileDiff.hunks[1]?.collapsedBefore).toBeGreaterThan(0)
  })

  test("converts legacy content into a patch", () => {
    const diff = {
      file: "a.ts",
      before: "one\n",
      after: "two\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toContain("@@ -1,1 +1,1 @@")
    expect(text(view, "deletions")).toBe("one\n")
    expect(text(view, "additions")).toBe("two\n")
  })

  test("ignores malformed persisted patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "diff --git a/a.ts b/a.ts\nindex ff4ceb2..65a1de0 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n keep\n+add\n same\r",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toBe(diff.patch)
    expect(text(view, "deletions")).toBe("")
    expect(text(view, "additions")).toBe("")
  })
})
