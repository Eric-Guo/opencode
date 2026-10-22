import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { createProxySettings, parseProxySettings } from "./proxy-settings"
import { getProxyEnvironment, getSessionProxyConfig } from "./proxy"
import { openDatabase } from "./storage/database"
import { createStateStore } from "./storage/state"

test.each([
  ["http://localhost:7890", "http://localhost:7890"],
  [" https://proxy.example:443/ ", "https://proxy.example"],
  ["http://[::1]:8080", "http://[::1]:8080"],
  ["http://proxy.example:80", "http://proxy.example"],
])("accepts and normalizes proxy endpoint %s", (url, normalized) => {
  expect(parseProxySettings({ mode: "manual", url, bypass: " .example.com; internal.test,internal.test " })).toEqual({
    mode: "manual",
    url: normalized,
    bypass: ".example.com,internal.test",
  })
})

test.each([
  "socks5://localhost:1080",
  "ftp://proxy.test",
  "localhost:8080",
  "http://",
  "http://proxy.test:0",
  "http://proxy.test:65536",
  "http://user:password@proxy.test",
  "http://@proxy.test",
  "http://:@proxy.test",
  "https://proxy.test/path",
  "https://proxy.test/path/..",
  "http:///proxy.test",
  "http://proxy.test?",
  "http://proxy.test#",
  "http://proxy.test\\",
  "http://pro\nxy.test",
])("rejects unsupported proxy URL %s", (url) => {
  expect(parseProxySettings({ mode: "manual", url, bypass: "" })).toBeUndefined()
})

test("rejects malformed IPC settings and bypass directives", () => {
  for (const value of [
    null,
    "direct",
    { mode: "unknown" },
    { mode: "manual", url: "http://proxy.test" },
    { mode: "manual", url: "http://proxy.test", bypass: "<-loopback>" },
  ])
    expect(parseProxySettings(value)).toBeUndefined()
})

test("saved settings take effect on the next launch, and a newer save survives startup acknowledgement", () => {
  const database = openDatabase(":memory:")
  const state = createStateStore(database.db)

  try {
    const first = createProxySettings(state)
    expect(first.get()).toEqual({ settings: { mode: "default" }, restartRequired: false })
    const manual = { mode: "manual", url: "http://proxy.test:8080", bypass: ".internal.test" } as const
    expect(first.set(manual)).toEqual({ ok: true, value: { settings: manual, restartRequired: true } })
    expect(first.active).toEqual({ mode: "default" })
    expect(first.pending()).toBe(false)
    // A separate reader sees the committed row without waiting for write-behind timers.
    const second = createProxySettings(createStateStore(database.db))
    expect(second.active).toEqual(manual)
    expect(second.pending()).toBe(true)
    second.set({ mode: "direct" })
    second.applied()
    expect(second.pending()).toBe(false)
    expect(second.get()).toEqual({ settings: { mode: "direct" }, restartRequired: true })
    const third = createProxySettings(createStateStore(database.db))
    expect(third.pending()).toBe(true)
    third.applied()
    expect(third.get().restartRequired).toBe(false)
    expect(third.set({ mode: "default" }).ok).toBe(true)
    const fourth = createProxySettings(createStateStore(database.db))
    expect(fourth.pending()).toBe(true)
    fourth.applied()
    expect(fourth.get()).toEqual({ settings: { mode: "default" }, restartRequired: false })
    expect(fourth.set({ mode: "manual", url: "socks5://proxy.test", bypass: "" })).toEqual({
      ok: false,
      error: "invalid",
    })
    expect(fourth.get().settings).toEqual({ mode: "default" })
  } finally {
    state.close()
    database.close()
  }
})

test("a rejected SQLite write is reported instead of acknowledging a save", () => {
  const database = openDatabase(":memory:")
  const state = createStateStore(database.db)
  const proxy = createProxySettings(state)

  try {
    database.db.run(sql`CREATE TRIGGER reject_proxy BEFORE INSERT ON state BEGIN SELECT RAISE(FAIL, 'read only'); END`)
    expect(proxy.set({ mode: "direct" })).toEqual({ ok: false, error: "storage" })
  } finally {
    database.db.run(sql`DROP TRIGGER reject_proxy`)
    state.close()
    database.close()
  }
})

test.each(["default", "manual", "direct"] as const)("resolves %s mode without modifying launch variables", (mode) => {
  const inherited = {
    http_proxy: "http://lower.test",
    HTTP_PROXY: "http://upper.test",
    ALL_PROXY: "socks5://inherited.test",
    WSS_PROXY: "http://ws.test",
    NO_PROXY: "inherited.test",
  }

  const before = { ...inherited }
  const settings = mode === "manual" ? { mode, url: "http://saved.test:8080", bypass: ".internal.test" } : { mode }
  const env = getProxyEnvironment(settings, inherited)
  expect(inherited).toEqual(before)
  expect(env.http_proxy).toBe({ manual: "http://saved.test:8080", direct: "", default: "http://lower.test" }[mode])
  expect(env.http_proxy).toBe(env.HTTP_PROXY)
  expect(env.https_proxy).toBe(env.HTTPS_PROXY)
  expect(env.wss_proxy).toBe(env.WSS_PROXY)
  expect(env.NO_PROXY).toContain("127.0.0.1,localhost,::1")
  expect(env.NO_PROXY).toBe(env.no_proxy)

  if (mode === "manual") {
    expect(env.HTTPS_PROXY).toBe(settings.url)
    expect(env.ALL_PROXY).toBe(settings.url)
    expect(env.WSS_PROXY).toBe(settings.url)
    expect(getSessionProxyConfig(settings, env)).toEqual({
      mode: "fixed_servers",
      proxyRules: settings.url,
      proxyBypassRules: "*.internal.test;127.0.0.1;localhost;::1;[::1]",
    })
  }

  if (mode === "direct") {
    expect(env.ALL_PROXY).toBe("")
    expect(env.WSS_PROXY).toBe("")
    expect(getSessionProxyConfig(settings, env)).toEqual({ mode: "direct" })
  }

  expect(getSessionProxyConfig({ mode: "default" }, {})).toEqual({ mode: "system" })
})
