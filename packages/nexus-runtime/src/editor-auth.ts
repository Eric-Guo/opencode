import { RequestError, type AgentContext, type ClientCapabilities } from "@agentclientprotocol/sdk"
import { setTimeout } from "node:timers/promises"
import type { Status } from "./runtime"

export type EditorAuthentication = {
  status(): Promise<Status>
  start(): Promise<{ url: string; code?: string }>
  credential(): Promise<string | null>
}

/** One editor observes the existing service-owned pairing and Human login ceremonies. */
export async function authenticateEditor(
  authentication: EditorAuthentication,
  peer: AgentContext,
  capabilities: ClientCapabilities,
  signal: AbortSignal,
  requestId: string | number | null,
) {
  const expires = performance.now() + 10 * 60000

  while (!signal.aborted) {
    if (performance.now() >= expires)
      throw RequestError.authRequired(undefined, "Nexus sign-in expired. Authenticate again.")

    const status = await authentication.status()

    if (status.state === "ready" && (await authentication.credential())) return status
    if (status.state === "error") throw new RequestError(-32603, status.error ?? "Nexus could not connect.")

    if (status.state === "connecting") {
      await setTimeout(1000, undefined, { signal })
      continue
    }

    const started = await authentication.start()
    const message = started.code
      ? `Open ${started.url} and enter: ${started.code}`
      : `Open ${started.url} to sign in to Nexus.`

    if (!capabilities.elicitation?.url)
      throw RequestError.authRequired(started, message + " Then call authenticate again.")

    const owner = new AbortController()
    const cancellationSignal = AbortSignal.any([signal, owner.signal])
    const elicitationId = crypto.randomUUID()
    const outcome: { refusal?: string } = {}

    void peer
      .request(
        "elicitation/create",
        { mode: "url", requestId, elicitationId, url: started.url, message },
        { cancellationSignal },
      )
      .then(
        (response) => {
          if (response.action !== "accept")
            outcome.refusal = "The Nexus sign-in card was closed before sign-in completed."
        },
        () => {
          if (!cancellationSignal.aborted) outcome.refusal = "The Nexus sign-in card was closed."
        },
      )

    try {
      const deadline = performance.now() + 5 * 60000

      while (!signal.aborted) {
        const current = await authentication.status()

        if (current.state === "error") throw new RequestError(-32603, current.error ?? "Nexus could not connect.")
        if (current.state === "ready" && (await authentication.credential())) return current
        // Pairing completed; Human login is a separate ceremony with its own card.
        if (status.state !== "ready" && current.state === "ready") break
        if (outcome.refusal) throw RequestError.authRequired(undefined, outcome.refusal)
        if (performance.now() >= deadline)
          throw RequestError.authRequired(undefined, "Nexus sign-in expired. Authenticate again.")

        await setTimeout(1000, undefined, { signal })
      }
    } finally {
      owner.abort()
      await peer.notify("elicitation/complete", { elicitationId }).catch(() => {})
    }
  }

  signal.throwIfAborted()
  throw RequestError.authRequired(undefined, "Nexus sign-in was cancelled.")
}

export async function authenticateEditorTerminal(
  authentication: EditorAuthentication,
  write: (message: string) => void,
  signal: AbortSignal,
) {
  const announced = new Set<string>()

  while (!signal.aborted) {
    const status = await authentication.status()

    if (status.state === "ready" && (await authentication.credential())) {
      write("Connected to Nexus.")
      return
    }
    if (status.state === "error") throw new Error(status.error ?? "Nexus could not connect.")
    if (status.state !== "connecting") {
      const started = await authentication.start()

      if (!announced.has(started.url)) {
        announced.add(started.url)
        write(started.url + (started.code ? "\nCode: " + started.code : ""))
      }
    }

    await setTimeout(1000, undefined, { signal })
  }

  signal.throwIfAborted()
}
