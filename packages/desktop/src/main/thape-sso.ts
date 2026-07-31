import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const SSO_SIGN_IN_URL = "https://sso.thape.com.cn/users/sign_in"
const CYBROS_CURRENT_USER_URL = "https://cybros.thape.com.cn/api/sigma_agents/me.json"
export const SSO_BEARER_KEY_FILE = ".thape-sso-bearer-api-key"

export type SsoSignInCredentials = {
  username: string
  password: string
}

type SsoRequest = (input: string, init?: RequestInit) => Promise<Response>

export async function loadSsoBearerApiKey(userDataPath: string, environmentValue?: string) {
  const saved = await readFile(join(userDataPath, SSO_BEARER_KEY_FILE), "utf8").catch(() => undefined)
  return saved?.trim() || environmentValue?.trim() || undefined
}

export async function getCybrosCurrentUser(
  userDataPath: string,
  bearerApiKey: string | undefined,
  onBearerRejected: () => void,
  request: SsoRequest = fetch,
) {
  if (!bearerApiKey) throw new Error("Cybros SSO bearer key is not configured")

  const response = await request(CYBROS_CURRENT_USER_URL, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerApiKey}`,
    },
  })
  if (response.status === 401) {
    await rm(join(userDataPath, SSO_BEARER_KEY_FILE), { force: true })
    onBearerRejected()
  }
  if (!response.ok) throw new Error(`Failed to load Cybros user: ${response.status}`)
  return response.json()
}

export async function signInToThapeSso(
  userDataPath: string,
  credentials: SsoSignInCredentials,
  request: SsoRequest = fetch,
) {
  const username = credentials.username.trim()
  if (!username || !credentials.password) throw new Error("Username and password are required")

  const response = await request(SSO_SIGN_IN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "JWT-AUD": "opencode",
    },
    body: JSON.stringify({
      user: {
        username,
        password: credentials.password,
      },
    }),
  })

  if (!response.ok) {
    if (response.status === 401 || response.status === 422) throw new Error("Incorrect username or password")
    throw new Error(`THAPE SSO sign in failed (${response.status})`)
  }

  const payload = await response.json().catch(() => undefined)
  if (!hasJwtToken(payload)) {
    throw new Error("Login failed by fetch JWT token, make sure you login in internal network")
  }

  await mkdir(userDataPath, { recursive: true })
  await writeFile(join(userDataPath, SSO_BEARER_KEY_FILE), `${payload.jwt_token.trim()}\n`, { mode: 0o600 })
  await chmod(join(userDataPath, SSO_BEARER_KEY_FILE), 0o600)
  return payload.jwt_token.trim()
}

function hasJwtToken(value: unknown): value is { jwt_token: string } {
  if (!value || typeof value !== "object" || !("jwt_token" in value)) return false
  return typeof value.jwt_token === "string" && value.jwt_token.trim().length > 0
}
