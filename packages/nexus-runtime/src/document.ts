import { APIError, TransportError, type Client, type StoreEntry } from "@cybros/agent"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"

type Store = Client["profile"]["storeEntries"]

/** One scoped current value. Reconcile uncertain writes without replaying the mutation. */
export class StoreDocument<T extends Schema.Json> {
  private entry?: StoreEntry
  private loaded = false
  private queue = Promise.resolve()

  constructor(
    private readonly store: Store,
    private readonly namespace: string,
    private readonly key: string,
    private readonly decode: (value: unknown) => T,
  ) {}

  read() {
    return this.serial(async () => {
      await this.load()

      return this.entry ? structuredClone(this.decode(this.entry.value)) : null
    })
  }

  change(edit: (current: T | null) => T) {
    return this.serial(async () => {
      await this.load()

      const value = this.decode(edit(this.entry ? structuredClone(this.decode(this.entry.value)) : null))

      if (this.entry && isDeepStrictEqual(this.entry.value, value)) return structuredClone(value)

      const published = this.entry
        ? this.store.update(this.entry.public_id, {
            value: Schema.decodeUnknownSync(Schema.MutableJson)(value),
            lock_version: this.entry.lock_version,
          })
        : this.store
            .create(
              { namespace: this.namespace, key: this.key, value: Schema.decodeUnknownSync(Schema.MutableJson)(value) },
              { idempotencyKey: crypto.randomUUID() },
            )
            .then((receipt) => receipt.store_entry)

      this.entry = await published.catch(async (error: unknown) => {
        if (
          !(error instanceof APIError || error instanceof TransportError) ||
          (error instanceof APIError && error.status === 429)
        )
          throw error

        this.loaded = false
        const observed = await this.find()

        this.entry = observed
        this.loaded = true

        if (observed && isDeepStrictEqual(observed.value, value)) return observed
        throw error
      })
      this.loaded = true

      return structuredClone(this.decode(this.entry.value))
    })
  }

  private serial<A>(run: () => Promise<A>) {
    const pending = this.queue.then(run)

    this.queue = pending.then(
      () => {},
      () => {},
    )

    return pending
  }

  private async load() {
    if (this.loaded) return

    this.entry = await this.find()
    this.loaded = true
  }

  private async find() {
    let after: string | undefined

    do {
      const page = await this.store.list({ after, limit: 100 })
      const row = page.items.find((entry) => entry.namespace === this.namespace && entry.key === this.key)

      if (row) return this.store.fetch(row.public_id)

      after = page.next_after ?? undefined
    } while (after)
  }
}
