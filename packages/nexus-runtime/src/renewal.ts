import { AuthorizationLost, ConnectionSuperseded, NotDurable, OAuthCredentials, type Fetch } from "@cybros/agent"
import { RealtimeClient } from "@cybros/agent/realtime"
import { scheduler } from "node:timers/promises"

const hour = 60 * 60 * 1000
const lead = 7 * 24 * hour
const verifyWindow = 5 * 60 * 1000
export const renewalClock = {
  now: Date.now,
  wait: (ms: number, signal: AbortSignal) => scheduler.wait(ms, { signal }),
}

/** One renewal owner for both credential planes of a paired Agent. */
export class AgentRenewal {
  readonly lost = new AbortController()
  private readonly sockets = new Set<WeakRef<RealtimeClient>>()
  private rebound: number
  private verification?: { at: number; work: Promise<void> }
  private pendingPublication = false
  issue?: string

  constructor(
    private readonly credentials: OAuthCredentials,
    private readonly clock = renewalClock,
  ) {
    this.rebound = credentials.rotation
  }

  async maintain(signal: AbortSignal) {
    while (!signal.aborted) {
      await this.check()
      if (!signal.aborted) await this.clock.wait(hour, signal)
    }
  }

  socket(options: ConstructorParameters<typeof RealtimeClient>[0]) {
    const socket = new RealtimeClient(options)
    this.sockets.add(new WeakRef(socket))
    return socket
  }

  options(baseURL: string, plane: "member" | "executor") {
    const credentialProvider = async () => {
      try {
        return await this.credentials.credential(plane)
      } catch (error) {
        this.observe(error)
        throw error
      }
    }
    const request: Fetch = async (input, init) => {
      const generation = this.credentials.rotation
      const response = await fetch(input, init)
      if (response.status !== 401 || this.lost.signal.aborted) return response

      // Both planes share one single-use refresh token. Join the lineage's verification
      // window even when multiple resources refuse it or the authority throttles refresh.
      if (this.credentials.rotation === generation) {
        const now = this.clock.now()
        if (!this.verification || now - this.verification.at >= verifyWindow)
          this.verification = { at: now, work: this.check(generation) }
        await this.verification.work
      }
      if (this.credentials.rotation === generation || this.lost.signal.aborted) return response
      await response.body?.cancel()
      const headers = new Headers(init?.headers)
      headers.set("Authorization", "Bearer " + (await credentialProvider()))
      return fetch(input, { ...init, headers })
    }
    return { baseURL, credentialProvider, fetch: request }
  }

  private async check(after?: number) {
    try {
      if (this.pendingPublication) {
        await this.credentials.persist()
        this.pendingPublication = false
      }
      if (after !== undefined || this.clock.now() >= Date.parse(this.credentials.expiresAt) - lead) {
        await this.credentials.refresh({ after: after ?? this.credentials.rotation })
      }
      this.issue = undefined
    } catch (error) {
      this.observe(error)
    } finally {
      const changed = this.rebound !== this.credentials.rotation
      this.rebound = this.credentials.rotation
      await Promise.all(
        [...this.sockets].map(async (ref) => {
          const socket = ref.deref()
          if (!socket) this.sockets.delete(ref)
          if (socket && changed) await socket.reconnect()
        }),
      )
    }
  }

  private observe(error: unknown) {
    if (error instanceof AuthorizationLost || error instanceof ConnectionSuperseded) this.lost.abort(error)
    if (error instanceof NotDurable) this.pendingPublication = true
    this.issue = error instanceof Error ? error.message : "Agent credential renewal was deferred."
  }
}
