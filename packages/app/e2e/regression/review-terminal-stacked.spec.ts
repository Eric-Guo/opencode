import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ReviewTerminalStacked"
const projectID = "proj_review_terminal_stacked"
const sessionID = "ses_review_terminal_stacked"
const title = "Review terminal stacked"
const branchDiffs = [
  fileDiff(".github/actions/setup-bun/action.yml", 7),
  ...Array.from({ length: 2_739 }, (_, index) =>
    fileDiff(`src/branch/generated-${String(index).padStart(4, "0")}.ts`, 100),
  ),
]

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
    pageMessages: () => ({ items: [] }),
  })
  await page.route(/\/vcs(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ branch: "review-pane-performance", default_branch: "dev" }),
    }),
  )
  await page.route("**/vcs/diff**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        new URL(route.request().url()).searchParams.get("mode") === "branch"
          ? branchDiffs
          : [fileDiff("src/git.ts", 1)],
      ),
    }),
  )
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
  await expect(page.getByRole("button", { name: "git.ts" })).toBeVisible()

  await page.keyboard.press("Control+Backquote")
  await expect(page.locator("#terminal-panel")).toBeVisible()
  // Terminal activation retries focus through 240ms; let that settle before opening the mode select.
  await page.waitForTimeout(300)
  await page.getByRole("button", { name: "Git changes" }).click()
  await page.getByRole("option", { name: "Branch changes" }).click()
  await expect(page.getByRole("tab", { name: "Review 2740" })).toBeVisible()
  await expect(page.getByRole("button", { name: "action.yml" })).toBeVisible()

  const tree = page.locator('#review-panel [data-component="file-tree-v2"]')
  await expect(tree).toHaveAttribute("data-total-rows", "2745")
  const renderedRows = await tree.locator('[data-slot="file-tree-v2-row"]').count()
  expect(renderedRows).toBeGreaterThan(0)
  expect(renderedRows).toBeLessThanOrEqual(60)

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

function fileDiff(file: string, additions: number) {
  return {
    file,
    additions,
    deletions: 0,
    status: "modified",
    patch: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export const value = 'before'\n+export const value = 'after'\n`,
  }
}
