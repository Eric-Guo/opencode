import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { Cache, Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"

class Catalog extends Context.Service<Catalog, { text: string }>()("test/Catalog") {}

const collect = global.gc
assert.ok(collect, "Run this fixture with --expose-gc")

const lookups = { count: 0 }
const cache = await Effect.runPromise(
  Cache.make({
    capacity: 200,
    lookup: () => Effect.sync(() => ++lookups.count),
  }),
)

// Like a built-in plugin, the activation wrapper captures the service context.
// Cache must retain the lookup result without keeping that old context alive.
async function activate() {
  const service = { text: "old model catalog" }
  const context = Context.make(Catalog, service)
  const plugin = {
    effect: () =>
      Effect.fn("Catalog.activate")(function* () {
        yield* Cache.get(cache, "statement")
      })().pipe(Effect.provide(context)),
  }

  await Effect.runPromise(plugin.effect())
  return { service: new WeakRef(service), context: new WeakRef(context) }
}

const old = await activate()
const deadline = performance.now() + 5_000

do {
  // A WeakRef read keeps its target alive for this job; cross a job boundary
  // before collecting again so the assertion itself cannot retain the context.
  await setImmediate()
  collect()
  if (old.service.deref() === undefined && old.context.deref() === undefined) break
} while (performance.now() < deadline)

assert.equal(old.service.deref(), undefined, "completed cache lookup retained the old service")
assert.equal(old.context.deref(), undefined, "completed cache lookup retained the old context")
assert.equal(await Effect.runPromise(Cache.get(cache, "statement")), 1)
assert.equal(lookups.count, 1, "release must not evict the cached result")

// A child finishing must not mutate the cache shared with a still-running parent.
// Render the parent's failure only after completion to exercise lazy diagnostics.
const failure = await Effect.runPromise(
  Effect.gen(function* () {
    const fail = Effect.fn("Catalog.refresh")(function* () {
      const child = yield* Effect.forkChild(Effect.void, { startImmediately: true })
      yield* Fiber.join(child)
      yield* Cache.get(cache, "another statement")
      return yield* Effect.fail(new Error("catalog refresh failed"))
    })
    const parent = Effect.fn("Catalog.reload")(function* () {
      return yield* fail()
    })
    const fiber = yield* Effect.forkChild(parent(), { startImmediately: true })
    return yield* Fiber.await(fiber)
  }).pipe(Effect.scoped),
)

assert.ok(Exit.isFailure(failure))
const diagnostics = Cause.pretty(failure.cause)
assert.match(diagnostics, /catalog refresh failed/)
assert.match(diagnostics, /Catalog\.refresh/)
assert.match(diagnostics, /Catalog\.reload/)
assert.match(diagnostics, /completed-fiber\.ts:\d+/)

const interrupted = await Effect.runPromise(
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const wait = Effect.fn("Catalog.wait")(function* () {
      yield* Deferred.succeed(ready, undefined)
      return yield* Effect.never
    })
    const fiber = yield* Effect.forkChild(wait(), { startImmediately: true })
    yield* Deferred.await(ready)
    yield* Fiber.interrupt(fiber)
    return yield* Fiber.await(fiber)
  }).pipe(Effect.scoped),
)

assert.ok(Exit.isFailure(interrupted))
assert.ok(Cause.hasInterrupts(interrupted.cause))
assert.match(Cause.pretty(interrupted.cause), /Catalog\.wait/)
console.log("completed-fiber regression passed")
