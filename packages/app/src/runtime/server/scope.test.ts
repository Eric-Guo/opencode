import { ServerConnection } from "@/runtime/server/registry"
import { describe, expect, test } from "bun:test"
import { ScopedKey, ServerScope, SessionRouteKey, SessionStateKey } from "./scope"

describe("ServerScope", () => {
  test.each([
    { name: "the canonical sidecar", key: "sidecar", canonical: undefined, scope: "local" },
    {
      name: "a configured loopback server",
      key: "http://localhost:4096",
      canonical: undefined,
      scope: "http://localhost:4096",
    },
    {
      name: "an explicit canonical web server",
      key: "http://localhost:4096",
      canonical: "http://localhost:4096",
      scope: "local",
    },
  ])("scopes $name as $scope", ({ key, canonical, scope }) => {
    expect(
      String(
        ServerScope.fromServerKey(
          ServerConnection.Key.make(key),
          canonical === undefined ? undefined : ServerConnection.Key.make(canonical),
        ),
      ),
    ).toBe(scope)
  })
})

describe("SessionStateKey", () => {
  test("combines local and remote scope with route identity and extracts the route again", () => {
    const route = SessionRouteKey.fromRoute("cmVwbw", "session-1")
    expect(String(SessionStateKey.from(ServerScope.local, route))).toBe("local\0cmVwbw/session-1")
    expect(
      String(
        SessionStateKey.from(ServerScope.fromServerKey(ServerConnection.Key.make("https://windows.example")), route),
      ),
    ).toBe("https://windows.example\0cmVwbw/session-1")
    expect(
      SessionStateKey.from(ServerScope.fromServerKey(ServerConnection.Key.make("https://debian.example")), route),
    ).not.toBe(
      SessionStateKey.from(ServerScope.fromServerKey(ServerConnection.Key.make("https://windows.example")), route),
    )
    expect(String(SessionStateKey.route("local\0cmVwbw/session-1"))).toBe("cmVwbw/session-1")
    expect(String(SessionStateKey.route("https://debian.example\0cmVwbw/session-1"))).toBe("cmVwbw/session-1")
  })

  test("rejects unscoped state keys", () => {
    expect(SessionStateKey.is("cmVwbw/session-1")).toBe(false)
    expect(SessionStateKey.is("local\0cmVwbw/session-1")).toBe(true)
    expect(() => SessionStateKey.route("cmVwbw/session-1")).toThrow("Session state key must include server scope")
    expect(() => SessionStateKey.scope("cmVwbw/session-1")).toThrow("Session state key must include server scope")
  })

  test("rejects invalid identity fragments", () => {
    expect(() => ScopedKey.from(ServerScope.local, "bad\0directory")).toThrow(
      "Scoped key part cannot contain null bytes",
    )
  })
})
