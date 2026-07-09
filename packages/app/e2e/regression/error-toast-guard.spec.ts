import { glob, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "../fixtures"

test("requires every browser spec to use the error toast fixture", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const files = await Array.fromAsync(glob("**/*.spec.{ts,tsx}", { cwd: root }))
  const unguarded = (
    await Promise.all(
      files.map(async (file) => {
        const source = await readFile(path.join(root, file), "utf8")
        if (/from\s+["'](?:\.\.\/)+fixtures["']/.test(source)) return
        if (/from\s+["']\.\.\/benchmark["']/.test(source)) return
        return file
      }),
    )
  ).filter((file): file is string => !!file)

  expect(unguarded).toEqual([])
})

test("allows an explicitly expected error toast", async ({ page, errorToasts }) => {
  errorToasts.expect("Expected request failure")

  await page.goto(
    `data:text/html,${encodeURIComponent(`
      <div data-component="toast-v2" data-variant="error">
        <div data-slot="toast-v2-title">Request failed</div>
        <div data-slot="toast-v2-description">Expected request failure</div>
      </div>
    `)}`,
  )

  await expect(page.locator('[data-component="toast-v2"]')).toBeVisible()
})

test("fails immediately on an unexpected error toast", async ({ page }) => {
  test.fail()

  await page.goto(
    `data:text/html,${encodeURIComponent(`
      <div data-component="toast" data-variant="error">
        <div data-slot="toast-title">Request failed</div>
        <div data-slot="toast-description">Unexpected request failure</div>
      </div>
    `)}`,
  )
  await page.waitForTimeout(10_000)
})
