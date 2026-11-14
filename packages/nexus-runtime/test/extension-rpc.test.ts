import { expect, test } from "bun:test"
import { Worker } from "node:worker_threads"
import { ExtensionRPC, extensionRPCBootstrap } from "../src/extension-rpc"

test("extension RPC preserves fluent methods, callback receivers, binary values and cancellation identity", async () => {
  const finished = Promise.withResolvers<Record<string, unknown>>()
  const cancellation = new AbortController()
  class Builder {
    constructor(readonly name: string) {}

    child(name: string) {
      return new Builder(this.name + "/" + name)
    }

    async read() {
      return new Blob([this.name], { type: "application/octet-stream" })
    }
  }
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    ${extensionRPCBootstrap}
    const rpc = createExtensionRPC(parentPort);
    (async () => {
      const object = rpc.root.record();
      const values = [...object];
      const asynchronous = [];
      for await (const value of object) asynchronous.push(value);
      const blob = await rpc.root.builder().child("file").read();
      const signal = rpc.root.signal();
      const same = signal === rpc.root.echo(signal);
      const callback = await rpc.root.invoke({ value: 7, execute(value) { return this.value + value + rpc.root.increment(1); } });
      const local = new AbortController();
      const observed = rpc.root.observe(local.signal);
      local.abort(new Error("Worker cancellation"));
      const observedReason = await observed;
      rpc.root.cancel();
      const reason = await new Promise(resolve => signal.aborted ? resolve(signal.reason.message) : signal.addEventListener("abort", () => resolve(signal.reason.message), { once: true }));
      const rejected = await rpc.root.reject().then(() => "unexpected", error => error.message);
      parentPort.postMessage({ result: { values, asynchronous, read: object.read(), blob: await blob.text(), type: blob.type, same, original: rpc.root.original(signal), callback, observedReason, reason, rejected, bytes: [...rpc.root.bytes()] } });
    })().catch(error => parentPort.postMessage({ error: error.stack }));
  `,
    { eval: true },
  )
  const rpc = new ExtensionRPC(worker, {
    builder: () => new Builder("root"),
    record: () => ({
      value: 3,
      read() {
        return this.value
      },
      *[Symbol.iterator]() {
        yield this.value
        yield this.value + 1
      },
      async *[Symbol.asyncIterator]() {
        yield this.value + 2
      },
    }),
    signal: () => cancellation.signal,
    echo: (signal: AbortSignal) => signal,
    original: (signal: AbortSignal) => signal === cancellation.signal,
    increment: (value: number) => value + 1,
    invoke: (callback: { execute(value: number): Promise<number> }) => callback.execute(5),
    observe: (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve(String(signal.reason.message)), { once: true })
      }),
    cancel: () => cancellation.abort(new Error("Host cancellation")),
    reject: () => Promise.reject(new Error("Immediate rejection")),
    bytes: () => new Uint8Array([1, 127, 255]),
  })
  worker.on("message", (message: { result?: Record<string, unknown>; error?: string }) => {
    if (message.result) finished.resolve(message.result)
    if (message.error) finished.reject(new Error(message.error))
  })
  worker.on("error", finished.reject)
  try {
    expect(await finished.promise).toEqual({
      values: [3, 4],
      asynchronous: [5],
      read: 3,
      blob: "root/file",
      type: "application/octet-stream",
      same: true,
      original: true,
      callback: 14,
      observedReason: "Worker cancellation",
      reason: "Host cancellation",
      rejected: "Immediate rejection",
      bytes: [1, 127, 255],
    })
  } finally {
    rpc.close()
    await worker.terminate()
  }
})
