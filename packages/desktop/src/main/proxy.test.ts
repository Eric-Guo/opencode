import { describe, expect, test } from "bun:test"

import { getElectronProxyConfig, getProxyBypassRules } from "./proxy"

describe("proxy env", () => {
  test("uses lowercase proxy env vars and preserves loopback bypass", () => {
    const config = getElectronProxyConfig({
      http_proxy: "http://127.0.0.1:6152",
      https_proxy: "http://127.0.0.1:6152",
      all_proxy: "socks5://127.0.0.1:6153",
      no_proxy: ".example.com,internal.test",
    })

    expect(config).toEqual({
      proxyRules: "http=http://127.0.0.1:6152;https=http://127.0.0.1:6152;socks=socks5://127.0.0.1:6153",
      proxyBypassRules: "*.example.com;internal.test;127.0.0.1;localhost;::1",
    })
  })

  test("falls back to all_proxy when scheme-specific vars are absent", () => {
    const config = getElectronProxyConfig({
      ALL_PROXY: "socks5://127.0.0.1:6153",
    })

    expect(config).toEqual({
      proxyRules: "socks5://127.0.0.1:6153",
      proxyBypassRules: "127.0.0.1;localhost;::1",
    })
  })

  test("always includes loopback in bypass rules", () => {
    expect(getProxyBypassRules({ NO_PROXY: "api.internal" })).toEqual(["api.internal", "127.0.0.1", "localhost", "::1"])
  })

  test("returns null when no proxy env is configured", () => {
    expect(getElectronProxyConfig({})).toBeNull()
  })
})
