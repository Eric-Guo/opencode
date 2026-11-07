import { describe, expect, test } from "bun:test"
import { extensionPages } from "~/component/site/extension-data"

const browse = extensionPages.find((extension) => extension.slug === "browse")!

describe("browse", () => {
  test("is a product at /product/browse with the Chrome Web Store as its main action", () => {
    expect(browse.product).toBe(true)
    expect(browse.store).toBe("https://chromewebstore.google.com/detail/mfnicocicmmlkpjnaffgihfjhdgjkdjg")
    expect(browse.source).toBe("https://github.com/anomalyco/browse")
  })

  test("leads with the extension, then offers standalone scripts and package manager commands for the CLI", () => {
    expect(browse.install.lead).toContain("[Chrome extension]")
    expect(browse.install.commands).toEqual([
      { method: "curl", command: "curl -fsSL https://opencode.ai/browse/install | bash" },
      { method: "pwsh", command: "irm https://opencode.ai/browse/install.ps1 | iex" },
      { method: "npm", command: "npm install -g @opencode/browse && browse install" },
      { method: "bun", command: "bun add -g @opencode/browse && browse install" },
    ])
    expect(browse.install.lead).not.toMatch(/node\.?js|npx/i)
  })

  test("keeps the documented title and description lengths", () => {
    expect(browse.title.length).toBeGreaterThanOrEqual(50)
    expect(browse.title.length).toBeLessThanOrEqual(60)
    expect(browse.description.length).toBeGreaterThanOrEqual(120)
    expect(browse.description.length).toBeLessThanOrEqual(160)
  })

  test("keeps the product name Browse", () => {
    expect(browse.name).toBe("Browse")
    const copy = [browse.body, browse.intro, ...browse.features.flatMap((feature) => [feature.title, feature.body])]
    expect(copy.some((line) => line.includes("—"))).toBe(false)
    expect(copy.some((line) => /deadbolt/i.test(line))).toBe(false)
  })
})
