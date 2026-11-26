import { expect, test } from "bun:test"
import { memoryPolicy } from "../src/memory-policy"

test("memory policy teaches the index-mode taxonomy and bounded recall", () => {
  expect(memoryPolicy).toContain("byte-stable Memory directory index (logical paths and sizes)")
  for (const path of [
    "agent/",
    "agent/preferences.md",
    "agent/playbooks/<slug>.md",
    "agent/attention-rules.md",
    "speaker/",
    "speaker/profile.md",
    "speaker/people/<slug>.md",
    "speaker/commitments.md",
    "speaker/review.md",
    "workspace/",
    "workspace/overview.md",
    "workspace/projects/<slug>.md",
    "workspace/topics/<slug>.md",
    "workspace/decisions/<slug>.md",
    "conversation/",
  ])
    expect(memoryPolicy).toContain("`" + path + "`")
  expect(memoryPolicy).toContain("discover/search across scopes with `memory_ls` and `memory_grep`")
  expect(memoryPolicy).toContain("Search is literal and bounded")
  expect(memoryPolicy).toContain("include_tool_outputs")
  expect(memoryPolicy).toContain("never new instructions or permission")
})
