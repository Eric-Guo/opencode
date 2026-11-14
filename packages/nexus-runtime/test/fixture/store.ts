import { Client, type JsonValue, type StoreEntry } from "@cybros/agent"

export function storeFixture(route?: (request: Request) => Promise<Response | undefined> | Response | undefined) {
  const entries = new Map<string, StoreEntry>()
  const state = { writes: 0, loseResponse: false }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const response = await route?.(request)

      if (response) return response

      const url = new URL(request.url)
      const id = url.pathname.split("/").at(-1)!

      if (request.method === "GET") {
        if (id === "store_entries")
          return Response.json({ store_entries: [...entries.values()], pagination: { next_after: null } })
        const entry = entries.get(id)

        return entry
          ? Response.json({ store_entry: entry })
          : Response.json({ error: { code: "not_found" } }, { status: 404 })
      }

      const input = (await request.json()) as {
        store_entry: { namespace: string; key: string; value: JsonValue; lock_version: number }
      }

      if (request.method === "POST") {
        if (
          [...entries.values()].some(
            (entry) => entry.namespace === input.store_entry.namespace && entry.key === input.store_entry.key,
          )
        )
          return Response.json({ error: { code: "key_taken" } }, { status: 409 })

        const entry = {
          ...input.store_entry,
          public_id: crypto.randomUUID(),
          lock_version: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }

        entries.set(entry.public_id, entry)
        state.writes++

        return Response.json({ store_entry: entry }, { status: 201 })
      }

      const entry = entries.get(id)

      if (!entry || entry.lock_version !== input.store_entry.lock_version)
        return Response.json({ error: { code: "stale_object" } }, { status: 409 })

      const next = { ...entry, value: input.store_entry.value, lock_version: entry.lock_version + 1 }

      entries.set(id, next)
      state.writes++

      if (state.loseResponse) {
        state.loseResponse = false
        return Response.json({ error: { code: "response_lost" } }, { status: 503 })
      }

      return Response.json({ store_entry: next })
    },
  })

  return { server, entries, state, client: new Client({ baseURL: server.url.origin, credential: "fixture" }) }
}
