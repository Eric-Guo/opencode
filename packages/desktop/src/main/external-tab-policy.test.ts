import { describe, expect, test } from "bun:test"
import {
  createExternalTabNavigationHandler,
  isExternalTabPermissionAllowed,
  isExternalTabURL,
} from "./external-tab-policy"

describe("external tab navigation", () => {
  test("keeps same-origin navigation and redirects embedded", () => {
    const tab = { url: "https://example.com/app/start" }
    const opened: string[] = []
    const event = { prevented: false, preventDefault: () => (event.prevented = true) }

    createExternalTabNavigationHandler(tab, (url) => opened.push(url))(
      event,
      "https://example.com/login/callback",
    )

    expect(event.prevented).toBe(false)
    expect(opened).toEqual([])
  })

  test("sends cross-origin redirects outside the embedded tab", () => {
    const tab = { url: "https://example.com/app" }
    const target = "https://auth.example.com/login"
    const opened: string[] = []
    const event = { prevented: false, preventDefault: () => (event.prevented = true) }

    createExternalTabNavigationHandler(tab, (url) => opened.push(url))(event, target)

    expect(event.prevented).toBe(true)
    expect(opened).toEqual([target])
  })

  test("keeps the SSO origin embedded as an explicit redirect exception", () => {
    const tab = { url: "https://app.thape.com.cn" }

    expect(isExternalTabURL(tab, "https://sso.thape.com.cn/login?redirect_uri=https://app.thape.com.cn")).toBe(true)
    expect(isExternalTabURL(tab, "http://sso.thape.com.cn/login")).toBe(false)
    expect(isExternalTabURL(tab, "https://sso.thape.com.cn:444/login")).toBe(false)
    expect(isExternalTabURL(tab, "https://fake-sso.thape.com.cn/login")).toBe(false)
  })

  test("still rejects scheme changes on the configured host", () => {
    expect(isExternalTabURL({ url: "https://example.com/app" }, "http://example.com/app")).toBe(false)
  })

  test("includes normalized ports in the configured origin", () => {
    expect(isExternalTabURL({ url: "https://example.com:443/app" }, "https://example.com/next")).toBe(true)
    expect(isExternalTabURL({ url: "https://example.com/app" }, "https://example.com:444/next")).toBe(false)
    expect(isExternalTabURL({ url: "http://localhost:3000" }, "http://localhost:3001")).toBe(false)
  })

  test("rejects invalid and opaque URLs", () => {
    expect(isExternalTabURL({ url: "https://example.com" }, "not a url")).toBe(false)
    expect(isExternalTabURL({ url: "data:text/html,configured" }, "data:text/html,target")).toBe(false)
  })
})

describe("external tab permissions", () => {
  test("allows supported permissions for a local server on its configured origin", () => {
    const tab = { url: "http://localhost:3000/app", localServer: true }

    expect(isExternalTabPermissionAllowed(tab, "clipboard-sanitized-write", "http://localhost:3000/editor")).toBe(
      true,
    )
    expect(isExternalTabPermissionAllowed(tab, "local-network-access", "http://localhost:3000")).toBe(true)
    expect(isExternalTabPermissionAllowed(tab, "local-network", "http://localhost:3000")).toBe(true)
    expect(isExternalTabPermissionAllowed(tab, "loopback-network", "http://localhost:3000")).toBe(true)
  })

  test("rejects local-server permissions from another port or origin", () => {
    const tab = { url: "http://localhost:3000/app", localServer: true }

    expect(isExternalTabPermissionAllowed(tab, "local-network-access", "http://localhost:3001")).toBe(false)
    expect(isExternalTabPermissionAllowed(tab, "local-network-access", "http://127.0.0.1:3000")).toBe(false)
    expect(isExternalTabPermissionAllowed(tab, "local-network-access", "https://localhost:3000")).toBe(false)
    expect(isExternalTabPermissionAllowed(tab, "local-network-access", "https://sso.thape.com.cn")).toBe(false)
  })

  test("rejects permissions for non-local tabs and unsupported capabilities", () => {
    const requestingURL = "http://localhost:3000"

    expect(isExternalTabPermissionAllowed({ url: requestingURL }, "local-network-access", requestingURL)).toBe(false)
    expect(
      isExternalTabPermissionAllowed({ url: requestingURL, localServer: true }, "notifications", requestingURL),
    ).toBe(false)
  })
})
