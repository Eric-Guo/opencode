import { ApplicationOAuth, OAuthCredentials, PlatformClient } from "@cybros/agent"
import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { vault } from "./storage"

export class HumanLogin {
  private listener?: Server
  private pending?: Promise<string>
  private callback?: Promise<void>
  private identity?: { origin: string; credentials: OAuthCredentials }
  private cancel?: AbortController

  constructor(private readonly directory: string) {}

  private store(origin: string) {
    return vault(join(this.directory, createHash("sha256").update(origin).digest("hex") + ".json"))
  }

  start(origin: string, identifier: string) {
    if (this.pending) return this.pending
    this.cancel = new AbortController()
    this.pending = this.listen(origin, identifier, this.cancel.signal).catch((error) => {
      this.pending = undefined
      throw error
    })
    return this.pending
  }

  private async listen(origin: string, identifier: string, signal: AbortSignal) {
    if (await this.account(origin)) throw new Error("Sign out of this Nexus account before signing in again.")
    const authority = new ApplicationOAuth({ baseURL: origin })
    const pkce = await ApplicationOAuth.pkce()
    signal.throwIfAborted()
    const server = createServer()
    this.listener = server
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Could not open the sign-in callback.")
    const redirect = "http://127.0.0.1:" + address.port + "/auth/callback"
    const timeout = setTimeout(() => {
      void this.close()
    }, 5 * 60000)
    timeout.unref()
    server.once("close", () => clearTimeout(timeout))
    server.on("request", (request, response) => {
      response.setHeader("Cache-Control", "no-store")
      response.setHeader("Content-Type", "text/plain; charset=utf-8")
      const url = URL.parse(request.url ?? "/", redirect)
      if (
        request.method !== "GET" ||
        request.headers.host !== new URL(redirect).host ||
        url?.pathname !== "/auth/callback" ||
        url.searchParams.get("state") !== pkce.state
      ) {
        response.writeHead(400).end("Invalid Nexus sign-in callback.")
        return
      }
      if (this.callback) {
        response.writeHead(409).end("Sign-in is being completed.")
        return
      }
      const code = url.searchParams.get("code")
      if (!code) {
        response.writeHead(400).end("Nexus sign-in was cancelled.")
        void this.close()
        return
      }
      this.callback = (async () => {
        const grant = await authority.exchangeCode(
          { code, redirect_uri: redirect, code_verifier: pkce.code_verifier },
          { signal },
        )
        if (!grant.platform_access_token || grant.agent || grant.runner || !grant.user)
          throw new Error("Unexpected Nexus login authority.")
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const credentials = await OAuthCredentials.issue({ authority, credentials: grant, store: this.store(origin) })
        this.identity = { origin, credentials }
        response.end("Signed in to Nexus. You can close this window.")
      })()
        .catch(() => {
          response.writeHead(400).end("Nexus could not complete sign-in. Start sign-in again in OpenCode.")
        })
        .finally(() => {
          server.close()
          this.listener = undefined
          this.callback = undefined
          this.pending = undefined
        })
    })
    return authority.authorizationURL({
      redirect_uri: redirect,
      state: pkce.state,
      code_challenge: pkce.code_challenge,
      connection_mode: "login",
      claims: { agent_identifier: identifier, agent_display_name: "OpenCode", executor_display_name: "OpenCode Local" },
    })
  }

  private async credentials(origin: string) {
    if (this.identity?.origin === origin) return this.identity.credentials
    const credentials = await OAuthCredentials.load({
      authority: new ApplicationOAuth({ baseURL: origin }),
      store: this.store(origin),
    })
    if (credentials) this.identity = { origin, credentials }
    return credentials
  }

  async account(origin: string) {
    const credentials = await this.credentials(origin)
    if (!credentials) return null
    const profile = await new PlatformClient({
      baseURL: origin,
      credentialProvider: credentials.provider("platform"),
    }).profile.fetch()
    if (profile.member.kind !== "human") throw new Error("Expected a Human Nexus account.")
    return { id: profile.member.public_id, role: profile.member.role }
  }

  async platform(origin: string) {
    const credentials = await this.credentials(origin)

    if (!credentials) throw new Error("Sign in to Nexus as a Human first.")

    const client = new PlatformClient({ baseURL: origin, credentialProvider: credentials.provider("platform") })

    if ((await client.profile.fetch()).member.kind !== "human") throw new Error("Expected a Human Nexus account.")

    return client
  }

  async logout(origin: string) {
    await this.close()
    const credentials = await this.credentials(origin)
    await credentials?.revoke()
    this.identity = undefined
  }

  async close() {
    this.cancel?.abort()
    await this.pending?.catch(() => {})
    this.listener?.close()
    await this.callback
    await this.identity?.credentials.drain()
    this.listener = undefined
    this.pending = undefined
  }
}
