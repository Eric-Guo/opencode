import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode/util/encode"
import { currentSession, mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/Users/test/opencode-new-project"
const selectedDirectory = "C:\\Users\\test\\opencode-new-project"
const projectID = "proj_new_project"
const draftID = "draft_new_project"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const headers = { "access-control-allow-origin": "*" }

test.use({ serviceWorkers: "block" })

for (const selection of ["missing", "unselected", "selected"] as const) {
  test(`new session submission with project ${selection}`, async ({ page }) => {
    const prompts: { sessionID: string; body: Record<string, unknown> }[] = []
    const sessions: ReturnType<typeof currentSession>[] = []
    const project = {
      id: projectID,
      worktree: directory,
      canonical: directory,
      time: { created: 1700000000000, updated: 1700000000000 },
      ...(selection === "selected"
        ? { myTodo: { project_id: 1, project_name: "Test PLM project", work_package_id: 42 } }
        : {}),
    }
    await mockOpenCodeServer(page, {
      directory,
      project,
      provider: {
        all: [
          {
            id: "opencode",
            name: "OpenCode",
            models: { "test-model": { id: "test-model", name: "Test Model", limit: { context: 200_000 } } },
          },
        ],
        connected: ["opencode"],
        default: { providerID: "opencode", modelID: "test-model" },
      },
      sessions,
      pageMessages: () => ({ items: [] }),
      onPrompt: (input) => prompts.push(input),
    })
    await page.route("**/api/project", (route) =>
      route.fulfill({ json: selection === "missing" && sessions.length === 0 ? [] : [project], headers }),
    )
    await page.route("**/api/session", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      const body: Record<string, unknown> = route.request().postDataJSON()
      expect(body.location).toEqual({ directory: selectedDirectory })
      if (typeof body.id !== "string") throw new Error("Expected a client-reserved session ID")
      const session = currentSession({ ...body, id: body.id, projectID, title: "First session" }, directory)
      sessions.push(session)
      return route.fulfill({ json: { data: session }, headers })
    })
    await page.addInitScript(
      ({ selectedDirectory, draftID, server }) => {
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: { local: [{ worktree: selectedDirectory, expanded: true }] },
            lastProject: { local: selectedDirectory },
          }),
        )
        localStorage.setItem(
          "opencode.window.browser.dat:tabs",
          JSON.stringify([{ type: "draft", draftID, server, directory: selectedDirectory }]),
        )
      },
      { selectedDirectory, draftID, server },
    )
    const location = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/location")
    await page.goto(`/new-session?draftId=${draftID}`)
    await location
    const editor = page.locator('[data-component="composer-editor"]')
    await expect(editor).toBeEditable()
    await editor.fill("Start my first session")
    const submit = page.locator('[data-action="composer-submit"]')
    if (selection === "unselected") {
      await expect(page.getByRole("button", { name: "Select PLM project", exact: true })).toBeVisible()
      await expect(submit).toBeDisabled()
      await editor.press("Enter")
      await expect(editor).toHaveText("Start my first session")
      expect(sessions).toHaveLength(0)
      expect(prompts).toHaveLength(0)
      return
    }
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect.poll(() => prompts.length).toBe(1)
    expect(sessions).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ sessionID: sessions[0].id, body: { text: "Start my first session" } })
    await expect(page).toHaveURL(`/server/${base64Encode(server)}/session/${sessions[0].id}`)
    if (selection === "missing")
      await expect(page.getByRole("button", { name: "Select PLM project", exact: true })).toBeVisible()
  })
}
