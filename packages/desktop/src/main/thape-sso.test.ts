import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getCybrosCurrentUser,
  loadSsoBearerApiKey,
  signInToThapeSso,
  SSO_BEARER_KEY_FILE,
} from "./thape-sso"

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "opencode-thape-sso-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("THAPE SSO", () => {
  test("loads the saved bearer key before the environment value", async () => {
    const root = await tempRoot()
    await writeFile(join(root, SSO_BEARER_KEY_FILE), "saved-token\n")

    expect(await loadSsoBearerApiKey(root, "environment-token")).toBe("saved-token")
  })

  test("falls back to the environment when the bearer key file is absent", async () => {
    expect(await loadSsoBearerApiKey(await tempRoot(), " environment-token ")).toBe("environment-token")
  })

  test("clears rejected bearer state so sign-in is available again", async () => {
    const root = await tempRoot()
    await writeFile(join(root, SSO_BEARER_KEY_FILE), "expired-token\n")
    const state: { bearerApiKey?: string; tabStateRefreshes: number } = {
      bearerApiKey: "expired-token",
      tabStateRefreshes: 0,
    }

    const result = getCybrosCurrentUser(
      root,
      state.bearerApiKey,
      () => {
        state.bearerApiKey = undefined
        state.tabStateRefreshes += 1
      },
      async () => new Response(undefined, { status: 401 }),
    )

    await expect(result).rejects.toThrow("Failed to load Cybros user: 401")
    expect(await loadSsoBearerApiKey(root)).toBeUndefined()
    expect(state.bearerApiKey).toBeUndefined()
    expect(state.tabStateRefreshes).toBe(1)
  })

  test("signs in and saves the returned JWT token", async () => {
    const root = await tempRoot()
    const requests: { input: string; init?: RequestInit }[] = []
    const request = async (input: string, init?: RequestInit) => {
      requests.push({ input, init })
      return Response.json({ jwt_token: "signed-in-token" }, { status: 201 })
    }

    expect(await signInToThapeSso(root, { username: " wuyipeng5 ", password: "secret" }, request)).toBe(
      "signed-in-token",
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toBe("https://sso.thape.com.cn/users/sign_in")
    expect(requests[0]?.init?.method).toBe("POST")
    expect(requests[0]?.init?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "JWT-AUD": "opencode",
    })
    const body = requests[0]?.init?.body
    expect(typeof body).toBe("string")
    if (typeof body !== "string") throw new Error("Expected a JSON request body")
    expect(JSON.parse(body)).toEqual({
      user: { username: "wuyipeng5", password: "secret" },
    })
    expect(await readFile(join(root, SSO_BEARER_KEY_FILE), "utf8")).toBe("signed-in-token\n")
  })

  test("does not save a key when credentials are rejected", async () => {
    const root = await tempRoot()
    const request = async () => new Response(undefined, { status: 401 })

    expect(signInToThapeSso(root, { username: "user", password: "wrong" }, request)).rejects.toThrow(
      "Incorrect username or password",
    )
    expect(await loadSsoBearerApiKey(root)).toBeUndefined()
  })

  test("reports when the sign-in response does not contain a JWT token", async () => {
    const root = await tempRoot()
    const request = async () => Response.json({}, { status: 201 })

    expect(signInToThapeSso(root, { username: "user", password: "secret" }, request)).rejects.toThrow(
      "Login failed by fetch JWT token, make sure you login in internal network",
    )
    expect(await loadSsoBearerApiKey(root)).toBeUndefined()
  })
})
