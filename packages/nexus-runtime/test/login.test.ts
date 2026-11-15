import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { HumanLogin } from "../src/login"

test("PKCE login binds its state to the loopback callback and restores a separate Human platform credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexus-login-"))
  const exchanges: URLSearchParams[] = []
  const authorizations: (string | null)[] = []
  using nexus = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/oauth/token") {
        exchanges.push(new URLSearchParams(await request.text()))
        return Response.json({
          plane: "platform",
          scope: "application",
          user: { public_id: "human", display_name: "Human", role: "member" },
          token_type: "Bearer",
          refresh_token: "fixture-refresh",
          access_token: "fixture-human",
          expires_in: 3600,
        })
      }
      if (path === "/api/v1/profile") {
        authorizations.push(request.headers.get("authorization"))
        return Response.json({
          member: { public_id: "human", role: "member", kind: "human" },
          credential_plane: "platform",
        })
      }
      if (path === "/oauth/revoke") return new Response(null)
      if (path === "/api/v1/admin/model_providers") {
        expect(request.headers.get("authorization")).toBe("Bearer fixture-human")
        expect(request.headers.get("idempotency-key")).toBe("operation")
        return Response.json({ model_providers: [] })
      }
      return new Response(null, { status: 404 })
    },
  })
  const login = new HumanLogin(directory)
  try {
    const authorization = new URL(await login.start(nexus.url.origin, "opencode.fixture"))
    expect(authorization.searchParams.get("connection_mode")).toBe("login")
    expect(authorization.searchParams.get("agent_identifier")).toBe("opencode.fixture")
    const callback = new URL(authorization.searchParams.get("redirect_uri")!)
    callback.searchParams.set("state", "wrong")
    callback.searchParams.set("code", "fixture-code")
    expect((await fetch(callback)).status).toBe(400)
    expect(exchanges).toBeEmpty()
    callback.searchParams.set("state", authorization.searchParams.get("state")!)
    expect((await fetch(callback)).status).toBe(200)
    expect(exchanges).toHaveLength(1)
    expect(createHash("sha256").update(exchanges[0]!.get("code_verifier")!).digest("base64url")).toBe(
      authorization.searchParams.get("code_challenge")!,
    )
    await login.close()
    const restored = new HumanLogin(directory)
    expect(await restored.account(nexus.url.origin)).toEqual({ id: "human", role: "member" })
    expect(authorizations).toEqual(["Bearer fixture-human"])
    await expect(
      restored.request(nexus.url.origin, { principal: "other", path: "/api/v1/admin/model_providers", method: "GET" }),
    ).rejects.toThrow("this Human")
    await expect(
      restored.request(nexus.url.origin, { principal: "human", path: "/api/v1/%2e%2e/private", method: "GET" }),
    ).rejects.toThrow("resource")
    expect(
      await restored.request(nexus.url.origin, {
        principal: "human",
        path: "/api/v1/admin/model_providers",
        method: "GET",
        key: "operation",
      }),
    ).toEqual({ model_providers: [] })
    expect(await restored.account("http://localhost:1")).toBeNull()
    await restored.logout(nexus.url.origin)
    expect(await restored.account(nexus.url.origin)).toBeNull()
  } finally {
    await login.close()
    await rm(directory, { recursive: true, force: true })
  }
})
