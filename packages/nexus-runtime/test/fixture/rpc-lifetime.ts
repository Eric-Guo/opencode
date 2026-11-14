import assert from "node:assert/strict"
import { Worker } from "node:worker_threads"
import { scheduler } from "node:timers/promises"
import { ExtensionRPC, extensionRPCBootstrap } from "../../src/extension-rpc"

declare const gc: () => void

class Value {
  constructor(readonly value: number) {}
  read() {
    return this.value
  }
}

const values: WeakRef<Value>[] = []
const signals: WeakRef<AbortSignal>[] = []
const outcome = Promise.withResolvers<void>()
const worker = new Worker(
  `
  const { parentPort } = require("node:worker_threads");
  ${extensionRPCBootstrap}
  const rpc = createExtensionRPC(parentPort);
  (async () => {
    let first = rpc.root.value(1);
    const second = rpc.root.value(2).read;
    const collected = first.read;
    if (collected() !== 1 || second() !== 2) throw new Error("Invalid method receiver");
    first = undefined;
    for (let index = 0; index < 64; index++) rpc.root.signal();
    parentPort.postMessage("created");
    parentPort.on("message", async (message) => {
      if (message !== "collect") return;
      gc();
      await new Promise(resolve => setImmediate(resolve));
      if (second() !== 2) throw new Error("A shared method lost its live receiver");
      parentPort.postMessage("collected");
    });
  })().catch(error => parentPort.postMessage({ error: error.stack }));
`,
  { eval: true },
)
const rpc = new ExtensionRPC(worker, {
  value(value: number) {
    const result = new Value(value)
    values.push(new WeakRef(result))
    return result
  },
  signal() {
    const result = new AbortController().signal
    signals.push(new WeakRef(result))
    return result
  },
})
const rounds: Array<() => void> = []
worker.on("error", outcome.reject)
worker.on("message", (message) => {
  if (message === "created") outcome.resolve()
  if (message === "collected") rounds.shift()?.()
  if (message?.error) outcome.reject(new Error(message.error))
})
try {
  await outcome.promise
  let collected = false
  for (let attempt = 0; attempt < 50; attempt++) {
    const round = Promise.withResolvers<void>()
    rounds.push(round.resolve)
    worker.postMessage("collect")
    await round.promise
    await scheduler.wait(5)
    gc()
    collected = !values[0].deref() && signals.every((signal) => !signal.deref())
    if (collected) break
  }
  assert(collected, "Dropped remote receivers and AbortSignals must release their host references")
  assert(values[1].deref(), "A retained bound method must retain its own receiver")
  process.stdout.write("RPC lifetimes released\n")
} finally {
  rpc.close()
  await worker.terminate()
}
