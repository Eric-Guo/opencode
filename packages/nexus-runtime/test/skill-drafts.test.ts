import { expect, test } from "bun:test"
import { maxDescriptionBytes, maxDrafts, SkillDrafts, SkillDraftsError } from "../src/skill-drafts"
import { storeFixture } from "./fixture/store"

function draftFixture() {
  const fixture = storeFixture()
  let now = new Date("2026-11-26T09:00:00Z")
  const drafts = new SkillDrafts(fixture.client.profile.storeEntries, () => now)

  return {
    fixture,
    drafts,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds)
    },
  }
}

test("propose upserts by scope and name preserving public_id and removes cleanly", async () => {
  const { fixture, drafts, advance } = draftFixture()

  try {
    const first = await drafts.propose({
      name: "weekly-digest",
      scope: "agent",
      description: "Summarize the week's commitments and open items.",
      content: "# Weekly Digest\n1. Check commitments.\n",
      conversation_public_id: "conv-1",
      workspace_public_id: "ws-1",
    })
    expect(first.name).toBe("weekly-digest")
    expect(first.scope).toBe("agent")
    expect(first.conversation_public_id).toBe("conv-1")
    expect(first.workspace_public_id).toBe("ws-1")
    expect(first.created_at).toBe("2026-11-26T09:00:00Z")
    expect(first.updated_at).toBe("2026-11-26T09:00:00Z")
    expect(await drafts.list()).toEqual([first])

    advance(60_000)
    const updated = await drafts.propose({
      name: "weekly-digest",
      scope: "agent",
      description: "Revised summary.",
      content: "# Weekly Digest v2\n",
    })
    expect(updated.public_id).toBe(first.public_id)
    expect(updated.created_at).toBe(first.created_at)
    expect(updated.updated_at).toBe("2026-11-26T09:01:00Z")
    // Fields the new proposal omits survive the upsert merge.
    expect(updated.conversation_public_id).toBe("conv-1")
    expect((await drafts.fetch(first.public_id)).description).toBe("Revised summary.")
    expect(await drafts.list()).toHaveLength(1)

    const removed = await drafts.remove(first.public_id)
    expect(removed.public_id).toBe(first.public_id)
    expect(await drafts.list()).toEqual([])
    await expect(drafts.fetch(first.public_id)).rejects.toThrow("No skill draft with public id " + first.public_id)
    await expect(drafts.remove(first.public_id)).rejects.toThrow("No skill draft with public id " + first.public_id)
  } finally {
    fixture.server.stop(true)
  }
})

test("invalid names, scopes and bounds are refused without persisting a draft", async () => {
  const { fixture, drafts } = draftFixture()

  try {
    const cases: [Parameters<SkillDrafts["propose"]>[0], string][] = [
      [
        { name: "Invalid_Name", scope: "agent", description: "desc", content: "body" },
        "skill name must match lowercase [a-z0-9] with single hyphens (max 64 chars)",
      ],
      [
        { name: "-leading", scope: "agent", description: "desc", content: "body" },
        "skill name must match lowercase [a-z0-9] with single hyphens (max 64 chars)",
      ],
      [
        { name: "valid", scope: "conversation", description: "desc", content: "body" },
        "scope must be agent or workspace",
      ],
      [
        { name: "valid", scope: "agent", description: "", content: "body" },
        "description is required and must fit within 1024 UTF-8 bytes",
      ],
      [
        { name: "valid", scope: "agent", description: "x".repeat(maxDescriptionBytes + 1), content: "body" },
        "description is required and must fit within 1024 UTF-8 bytes",
      ],
      [
        { name: "valid", scope: "agent", description: "é".repeat(513), content: "body" },
        "description is required and must fit within 1024 UTF-8 bytes",
      ],
      [
        { name: "valid", scope: "agent", description: "desc", content: "   " },
        "content is required and must fit within 65536 UTF-8 bytes",
      ],
    ]

    for (const [fields, message] of cases) {
      await expect(drafts.propose(fields)).rejects.toThrow(SkillDraftsError)
      await expect(drafts.propose(fields)).rejects.toThrow(message)
    }
    expect(await drafts.list()).toEqual([])

    // A description of exactly 1024 UTF-8 bytes fits.
    const boundary = await drafts.propose({
      name: "valid",
      scope: "agent",
      description: "é".repeat(512),
      content: "body",
    })
    expect(Buffer.byteLength(boundary.description)).toBe(maxDescriptionBytes)
  } finally {
    fixture.server.stop(true)
  }
})

test("the draft beyond the catalog maximum is refused", async () => {
  const { fixture, drafts } = draftFixture()

  try {
    for (let index = 0; index < maxDrafts; index++) {
      await drafts.propose({ name: "skill-" + index, scope: "agent", description: "desc", content: "body" })
    }
    await expect(
      drafts.propose({ name: "skill-" + maxDrafts, scope: "agent", description: "desc", content: "body" }),
    ).rejects.toThrow("Too many pending skill drafts (max 32); approve or dismiss existing drafts first")
    expect(await drafts.list()).toHaveLength(maxDrafts)
  } finally {
    fixture.server.stop(true)
  }
})
