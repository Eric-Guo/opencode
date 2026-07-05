import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ReviewTerminalStacked"
const projectID = "proj_review_terminal_stacked"
const sessionID = "ses_review_terminal_stacked"
const title = "Review terminal stacked"

test("keeps the review tree and terminal sized when both panels are open", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "review-terminal-stacked",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "review-terminal-stacked",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    vcsDiff: [
      {
        file: "src/example.ts",
        additions: 1,
        deletions: 1,
        status: "modified",
        patch:
          "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export const value = 'before'\n+export const value = 'after'\n",
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/pty", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "pty_review_terminal", title: "Terminal 1" }),
    }),
  )
  await page.route("**/pty/pty_review_terminal", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  )
  await page.routeWebSocket("**/pty/pty_review_terminal/connect", () => undefined)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.getByRole("button", { name: "Toggle review" }).click()
  await expect(page.getByRole("button", { name: "example.ts" })).toBeVisible()

  await page.keyboard.press("Control+Backquote")
  await expect(page.locator("#terminal-panel")).toBeVisible()
  await expect(page.getByRole("button", { name: "example.ts" })).toBeVisible()

  const geometry = await page.evaluate(() => {
    const review = document.querySelector<HTMLElement>("#review-panel")!
    const terminal = document.querySelector<HTMLElement>("#terminal-panel")!
    const reviewParent = review.parentElement!.getBoundingClientRect()
    const terminalParent = terminal.parentElement!.getBoundingClientRect()
    return {
      review: review.getBoundingClientRect().height,
      reviewParent: reviewParent.height,
      terminal: terminal.getBoundingClientRect().height,
      terminalParent: terminalParent.height,
    }
  })
  expect(Math.abs(geometry.review - geometry.reviewParent)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry.terminal - geometry.terminalParent)).toBeLessThanOrEqual(1)
})

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
