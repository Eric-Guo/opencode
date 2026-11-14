/* eslint-disable no-restricted-globals -- The RPC boundary reflects arbitrary extension methods and SDK objects. */
import {
  SDKError,
  MalformedResponse,
  TransportError,
  TimeoutError,
  CancelledError,
  RedirectError,
  APIError,
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  Conflict,
  InvalidRequest,
  RateLimited,
  ServerError,
  AuthorizationLost,
  NotDurable,
  Published,
  RetentionGap,
  BufferOverflow,
  RealtimeDisconnected,
} from "@cybros/agent"
import { MessageChannel, receiveMessageOnPort, type MessagePort, type Worker } from "node:worker_threads"

type ErrorType = { name: string; prototype: Error }
const sdkErrors: readonly (readonly [string, ErrorType])[] = [
  ["SDKError", SDKError],
  ["MalformedResponse", MalformedResponse],
  ["TransportError", TransportError],
  ["TimeoutError", TimeoutError],
  ["CancelledError", CancelledError],
  ["RedirectError", RedirectError],
  ["APIError", APIError],
  ["BadRequest", BadRequest],
  ["Unauthorized", Unauthorized],
  ["Forbidden", Forbidden],
  ["NotFound", NotFound],
  ["Conflict", Conflict],
  ["InvalidRequest", InvalidRequest],
  ["RateLimited", RateLimited],
  ["ServerError", ServerError],
  ["AuthorizationLost", AuthorizationLost],
  ["NotDurable", NotDurable],
  ["Published", Published],
  ["RetentionGap", RetentionGap],
  ["BufferOverflow", BufferOverflow],
  ["RealtimeDisconnected", RealtimeDisconnected],
]

type Port = {
  on(event: "message", listener: (value: unknown) => void): unknown
  off(event: "message", listener: (value: unknown) => void): unknown
  postMessage(value: unknown, transferList?: readonly MessagePort[]): void
}
type Wire =
  | { type: "primitive"; value: unknown }
  | { type: "array"; value: Wire[] }
  | { type: "record"; value: [string | { symbol: string }, Wire][] }
  | { type: "map"; value: [Wire, Wire][] }
  | { type: "set"; value: Wire[] }
  | { type: "error"; name: string; constructors: string[]; message: string; stack?: string; fields: [string, Wire][] }
  | { type: "signal"; side: string; id: number; lease: number; aborted: boolean; reason?: Wire }
  | {
      type: "reference"
      side: string
      id: number
      lease?: number
      kind: string
      receiver?: number
      fields: [string, Wire][]
      keys: string[]
    }
type Request = {
  rpc: true
  type: "request"
  id: number
  operation: string
  reference: number
  key?: string
  args?: Wire[]
  receiver?: number
  sync?: SharedArrayBuffer
}
type Reply = { rpc: true; type: "reply"; id: number; ok: boolean; value: Wire }
type Message =
  | Request
  | Reply
  | { rpc: true; type: "connect"; port: MessagePort }
  | { rpc: true; type: "abort"; id: number; reason: Wire }
  | { rpc: true; type: "release"; leases: number[] }
  | { rpc: true; type: "close"; reason: Wire }

/** Host callbacks remain asynchronous; only the isolated worker blocks for synchronous API projections. */
export class ExtensionRPC {
  private readonly endpoint
  private readonly exit = () => this.close(new Error("Extension worker exited."))
  private readonly error = (error: Error) => this.close(error)

  constructor(
    private readonly worker: Worker,
    root: object,
  ) {
    this.endpoint = createEndpoint(worker, root, false, MessageChannel, receiveMessageOnPort, sdkErrors)
    worker.once("exit", this.exit)
    worker.once("error", this.error)
  }

  close(reason = new Error("Extension worker RPC closed.")) {
    this.worker.off("exit", this.exit)
    this.worker.off("error", this.error)
    this.endpoint.close(reason)
  }
}

// The compiled function is self-contained: its only platform services are passed explicitly.
export const extensionRPCBootstrap = `function createExtensionRPC(parentPort, errorConstructors = []) {
  const transport = require("node:worker_threads");
  return (${createEndpoint.toString()})(parentPort, undefined, true, transport.MessageChannel, transport.receiveMessageOnPort, errorConstructors);
}`

function createEndpoint(
  port: Port,
  root: object | undefined,
  blocking: boolean,
  Channel: typeof MessageChannel,
  receive: typeof receiveMessageOnPort,
  errorConstructors: readonly (readonly [string, ErrorType])[],
) {
  const side = blocking ? "worker" : "parent"
  const opposite = blocking ? "parent" : "worker"
  const references = new Map<number, unknown>(root ? [[0, root]] : [])
  const identities = new WeakMap<object, number>()
  const proxies = new Map<string, WeakRef<object>>()
  const remote = new WeakMap<object, Extract<Wire, { type: "reference" }>>()
  const controllers = new Map<number, WeakRef<AbortController>>()
  const signalOwners = new WeakMap<AbortSignal, AbortController>()
  const signalMetadata = new WeakMap<AbortSignal, Extract<Wire, { type: "signal" }>>()
  const exposures = new WeakMap<object, Set<number>>()
  const leases = new Map<number, number[]>()
  const retained = new Map<number, number>()
  const errors = new Map(errorConstructors)
  const errorLabels = new Map(errorConstructors.map(([name, constructor]) => [constructor, name]))
  const listeners = new Map<number, { signal: AbortSignal; abort: () => void }>()
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>()
  const counters = { reference: 0, request: 0, lease: 0 }
  const state: { closed?: Error; response?: MessagePort } = {}
  if (root) identities.set(root, 0)
  const symbols = new Map<string, symbol>([
    ["@@iterator", Symbol.iterator],
    ["@@asyncIterator", Symbol.asyncIterator],
    ["@@toStringTag", Symbol.toStringTag],
    ["@@dispose", Symbol.dispose],
    ["@@asyncDispose", Symbol.asyncDispose],
    ["@@toPrimitive", Symbol.toPrimitive],
    ["@@hasInstance", Symbol.hasInstance],
    ["@@isConcatSpreadable", Symbol.isConcatSpreadable],
    ["@@match", Symbol.match],
    ["@@matchAll", Symbol.matchAll],
    ["@@replace", Symbol.replace],
    ["@@search", Symbol.search],
    ["@@split", Symbol.split],
    ["@@species", Symbol.species],
    ["@@unscopables", Symbol.unscopables],
  ])
  const knownKey = (value: string | symbol) =>
    typeof value === "string" || [...symbols.values()].includes(value) || Symbol.keyFor(value) !== undefined
  const property = (value: string) =>
    symbols.get(value) ?? (value.startsWith("@@global:") ? Symbol.for(value.slice(9)) : value)
  const key = (value: string | symbol) =>
    typeof value === "string"
      ? value
      : ([...symbols].find((row) => row[1] === value)?.[0] ??
        (Symbol.keyFor(value)
          ? "@@global:" + Symbol.keyFor(value)
          : (() => {
              throw new Error("Unregistered symbols cannot cross extension workers.")
            })()))
  const send = (value: Message) => {
    if (!state.closed) port.postMessage(value)
  }
  const reference = (value: object) => {
    const previous = identities.get(value)
    if (previous !== undefined && references.has(previous)) return previous
    const id = ++counters.reference
    identities.set(value, id)
    references.set(id, value)
    return id
  }
  const finalizer = new FinalizationRegistry<{ identity?: string; signal?: number; leases: Set<number> }>((held) => {
    if (held.identity && !proxies.get(held.identity)?.deref()) proxies.delete(held.identity)
    if (held.signal !== undefined && !controllers.get(held.signal)?.deref()) controllers.delete(held.signal)
    send({ rpc: true, type: "release", leases: [...held.leases] })
  })
  const lease = (id: number, receiver?: number) => {
    const serial = ++counters.lease
    const owners = [...new Set(receiver === undefined ? [id] : [id, receiver])]
    leases.set(serial, owners)
    for (const owner of owners) retained.set(owner, (retained.get(owner) ?? 0) + 1)
    return serial
  }
  const expose = (value: object, current: number | undefined, identity?: string, signal?: number) => {
    if (current === undefined) return
    const previous = exposures.get(value)
    if (previous) {
      if (previous.has(current)) return
      send({ rpc: true, type: "release", leases: [...previous] })
      previous.clear()
      previous.add(current)
      return
    }
    const held = new Set([current])
    exposures.set(value, held)
    finalizer.register(value, { identity, signal, leases: held })
  }
  const release = (serial: number) => {
    const owners = leases.get(serial)
    if (!owners) return
    leases.delete(serial)
    for (const owner of owners) {
      const remaining = (retained.get(owner) ?? 1) - 1
      if (remaining > 0) {
        retained.set(owner, remaining)
        continue
      }
      retained.delete(owner)
      if (owner === 0) continue
      references.delete(owner)
      const held = listeners.get(owner)
      if (held) held.signal.removeEventListener("abort", held.abort)
      listeners.delete(owner)
    }
  }

  function errorNames(error: Error) {
    const names: string[] = []
    for (
      let prototype = Object.getPrototypeOf(error);
      prototype && prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      const constructor = Reflect.getOwnPropertyDescriptor(prototype, "constructor")?.value
      if (typeof constructor === "function" && constructor.name)
        names.push(errorLabels.get(constructor) ?? constructor.name)
    }
    return names
  }

  function encode(value: unknown, receiver?: number, seen = new WeakSet<object>()): Wire {
    if (value === null || (typeof value !== "object" && typeof value !== "function"))
      return { type: "primitive", value }
    const prior = remote.get(value)
    if (prior) return prior
    if (value instanceof AbortSignal) {
      const mirrored = signalMetadata.get(value)
      if (mirrored) return mirrored
      const id = reference(value)
      if (!listeners.has(id) && !value.aborted) {
        const abort = () => {
          listeners.delete(id)
          send({ rpc: true, type: "abort", id, reason: encode(value.reason) })
        }
        listeners.set(id, { signal: value, abort })
        value.addEventListener("abort", abort, { once: true })
      }
      return {
        type: "signal",
        side,
        id,
        lease: lease(id),
        aborted: value.aborted,
        ...(value.aborted ? { reason: encode(value.reason) } : {}),
      }
    }
    if (
      value instanceof ArrayBuffer ||
      value instanceof SharedArrayBuffer ||
      ArrayBuffer.isView(value) ||
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Blob
    )
      return { type: "primitive", value }
    if (value instanceof Error)
      return {
        type: "error",
        name: value.name,
        constructors: errorNames(value),
        message: value.message,
        stack: value.stack,
        fields: Object.getOwnPropertyNames(value)
          .filter((name) => !["name", "message", "stack"].includes(name))
          .map((name) => [
            name,
            encode(
              Reflect.get(value, name),
              typeof Reflect.get(value, name) === "function" ? reference(value) : undefined,
              seen,
            ),
          ]),
      }
    if (!seen.has(value)) {
      seen.add(value)
      if (Array.isArray(value)) return { type: "array", value: value.map((item) => encode(item, undefined, seen)) }
      if (value instanceof Map)
        return {
          type: "map",
          value: [...value].map(([key, entry]) => [encode(key, undefined, seen), encode(entry, undefined, seen)]),
        }
      if (value instanceof Set) return { type: "set", value: [...value].map((item) => encode(item, undefined, seen)) }
      if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
        return {
          type: "record",
          value: Reflect.ownKeys(value)
            .filter(knownKey)
            .map((name) => [
              typeof name === "string" ? name : { symbol: key(name) },
              encode(
                Reflect.get(value, name),
                typeof Reflect.get(value, name) === "function" ? reference(value) : undefined,
                seen,
              ),
            ]),
        }
    }
    const fields: [string, Wire][] = []
    const keys = new Set<string>()
    for (
      let current: object | null = value;
      current && current !== Object.prototype;
      current = Object.getPrototypeOf(current)
    ) {
      for (const name of Reflect.ownKeys(current)) {
        if (name === "constructor" || !knownKey(name)) continue
        const encoded = key(name)
        keys.add(encoded)
        const descriptor = Reflect.getOwnPropertyDescriptor(current, name)
        if (
          current === value &&
          descriptor &&
          "value" in descriptor &&
          (descriptor.value === null || !["object", "function"].includes(typeof descriptor.value))
        )
          fields.push([encoded, encode(descriptor.value)])
      }
    }
    if (value instanceof Promise) void value.catch(() => {})
    const id = reference(value)
    return {
      type: "reference",
      side,
      id,
      lease: lease(id, receiver),
      kind: typeof value === "function" ? "function" : value instanceof Promise ? "promise" : "object",
      ...(receiver === undefined ? {} : { receiver }),
      fields,
      keys: [...keys],
    }
  }

  function request(
    operation: string,
    id: number,
    args: Wire[] = [],
    name?: string,
    receiver?: number,
    synchronous = blocking,
  ): unknown {
    if (state.closed) throw state.closed
    const serial = ++counters.request
    const message: Request = {
      rpc: true,
      type: "request",
      id: serial,
      operation,
      reference: id,
      args,
      ...(name === undefined ? {} : { key: name }),
      ...(receiver === undefined ? {} : { receiver }),
    }
    if (!synchronous) {
      const result = Promise.withResolvers<unknown>()
      pending.set(serial, result)
      try {
        port.postMessage(message)
      } catch (error) {
        pending.delete(serial)
        result.reject(error)
      }
      return result.promise
    }
    const signal = new Int32Array(new SharedArrayBuffer(4))
    port.postMessage({ ...message, sync: signal.buffer })
    if (Atomics.wait(signal, 0, 0, 30000) === "timed-out")
      throw new Error("Extension API projection did not respond before its deadline.")
    const result = receive(state.response!)?.message as Reply | undefined
    if (!result || result.id !== serial || result.type !== "reply")
      throw new Error("Extension API response channel lost its request ordering.")
    const decoded = decode(result.value)
    if (!result.ok) throw decoded
    return decoded
  }

  function proxy(value: Extract<Wire, { type: "reference" }>) {
    if (value.side === side) return references.get(value.id)
    const identity = value.id + ":" + (value.receiver ?? "")
    const previous = proxies.get(identity)?.deref()
    if (previous) {
      expose(previous, value.lease)
      remote.set(previous, value)
      return previous
    }
    const fields = new Map(value.fields)
    const target = value.kind === "function" ? function () {} : {}
    const result = new Proxy(target, {
      get(target, name) {
        if (!knownKey(name)) return undefined
        if (name === "then")
          return value.kind === "promise"
            ? (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
                (request("await", value.id, [], undefined, undefined, false) as Promise<unknown>).then(resolve, reject)
            : undefined
        if (!blocking) {
          if (name === Symbol.asyncIterator)
            return () => {
              const iterator = request("method", value.id, [], "@@asyncIterator", undefined, false) as Promise<
                AsyncIterator<unknown>
              >
              return {
                next: (input: unknown) => iterator.then((held) => held.next(input)),
                return: (input: unknown) =>
                  iterator.then((held) => (held.return ? held.return(input) : { done: true, value: input })),
              }
            }
          const field = fields.get(key(name))
          if (field) return decode(field)
          if (!value.keys.includes(key(name))) return Reflect.get(target, name)
          return (...args: unknown[]) =>
            request(
              "method",
              value.id,
              args.map((arg) => encode(arg)),
              key(name),
              undefined,
              false,
            )
        }
        const own = Reflect.getOwnPropertyDescriptor(target, name)
        if (own && !own.configurable && "value" in own && !own.writable) return own.value
        return request("get", value.id, [], key(name))
      },
      apply(_target, _receiver, args) {
        return request(
          "call",
          value.id,
          args.map((arg) => encode(arg)),
          undefined,
          value.receiver,
        )
      },
      has(_target, name) {
        if (!knownKey(name)) return false
        return blocking ? Boolean(request("has", value.id, [], key(name))) : value.keys.includes(key(name))
      },
      ownKeys(target) {
        return [
          ...new Set([
            ...Reflect.ownKeys(target),
            ...(blocking ? (request("keys", value.id) as string[]) : value.keys).map(property),
          ]),
        ]
      },
      getOwnPropertyDescriptor(target, name) {
        return (
          Reflect.getOwnPropertyDescriptor(target, name) ?? {
            configurable: true,
            enumerable: true,
            get: () => Reflect.get(result, name),
          }
        )
      },
      set(_target, name, next) {
        if (!blocking) throw new Error("Write extension callback state inside its worker.")
        return Boolean(request("set", value.id, [encode(next)], key(name)))
      },
    })
    remote.set(result, value)
    proxies.set(identity, new WeakRef(result))
    expose(result, value.lease, identity)
    return result
  }

  function decode(value: Wire): unknown {
    switch (value.type) {
      case "primitive":
        return value.value
      case "array":
        return value.value.map(decode)
      case "record":
        return Object.fromEntries(
          value.value.map(([key, entry]) => [typeof key === "string" ? key : property(key.symbol), decode(entry)]),
        )
      case "map":
        return new Map(value.value.map(([key, entry]) => [decode(key), decode(entry)]))
      case "set":
        return new Set(value.value.map(decode))
      case "reference":
        return proxy(value)
      case "error": {
        const error =
          value.name === "TypeError"
            ? new TypeError(value.message)
            : value.name === "RangeError"
              ? new RangeError(value.message)
              : new Error(value.message)
        const constructor = value.constructors.map((name) => errors.get(name)).find((value) => value !== undefined)
        if (constructor) Object.setPrototypeOf(error, constructor.prototype)
        error.name = value.name
        error.stack = value.stack
        for (const [key, entry] of value.fields) Reflect.set(error, key, decode(entry))
        return error
      }
      case "signal": {
        if (value.side === side) return references.get(value.id)
        const held = controllers.get(value.id)?.deref() ?? new AbortController()
        controllers.set(value.id, new WeakRef(held))
        signalOwners.set(held.signal, held)
        signalMetadata.set(held.signal, value)
        expose(held.signal, value.lease, undefined, value.id)
        if (value.aborted) held.abort(value.reason ? decode(value.reason) : undefined)
        return held.signal
      }
    }
  }

  function perform(message: Request) {
    const value = references.get(message.reference)
    if (message.operation === "await") return value
    if (value === null || (typeof value !== "object" && typeof value !== "function"))
      throw new Error("Extension API reference expired.")
    const name = message.key === undefined ? undefined : property(message.key)
    if (message.operation === "get") {
      const item = Reflect.get(value, name!)
      return { encoded: encode(item, typeof item === "function" ? message.reference : undefined) }
    }
    if (message.operation === "keys") return Reflect.ownKeys(value).filter(knownKey).map(key)
    if (message.operation === "has") return Reflect.has(value, name!)
    if (message.operation === "set") return Reflect.set(value, name!, decode(message.args![0]))
    const args = (message.args ?? []).map(decode)
    const fn = message.operation === "method" ? Reflect.get(value, name!) : value
    if (typeof fn !== "function") throw new TypeError("Extension API member is not callable.")
    return Reflect.apply(
      fn,
      message.operation === "method"
        ? value
        : message.receiver === undefined
          ? undefined
          : references.get(message.receiver),
      args,
    )
  }

  function onMessage(input: unknown) {
    if (input === null || typeof input !== "object" || !("rpc" in input) || input.rpc !== true) return
    const message = input as Message
    if (message.type === "connect") {
      state.response = message.port
      return
    }
    if (message.type === "reply") {
      const held = pending.get(message.id)
      if (!held) return
      pending.delete(message.id)
      try {
        if (message.ok) held.resolve(decode(message.value))
        else held.reject(decode(message.value))
      } catch (error) {
        held.reject(error)
      }
      return
    }
    if (message.type === "abort") {
      controllers.get(message.id)?.deref()?.abort(decode(message.reason))
      return
    }
    if (message.type === "release") {
      message.leases.forEach(release)
      return
    }
    if (message.type === "close") {
      close(decode(message.reason) as Error, false)
      return
    }
    if (message.type !== "request") return
    const answer = (ok: boolean, value: unknown) => {
      try {
        const encoded = message.operation === "get" && ok ? (value as { encoded: Wire }).encoded : encode(value)
        const reply: Reply = { rpc: true, type: "reply", id: message.id, ok, value: encoded }
        if (message.sync) state.response!.postMessage(reply)
        else send(reply)
      } catch (error) {
        const reply: Reply = { rpc: true, type: "reply", id: message.id, ok: false, value: encode(error) }
        if (message.sync) state.response?.postMessage(reply)
        else send(reply)
      } finally {
        if (message.sync) {
          const signal = new Int32Array(message.sync)
          Atomics.store(signal, 0, 1)
          Atomics.notify(signal, 0)
        }
      }
    }
    try {
      if (state.closed) throw state.closed
      const result = perform(message)
      if (message.sync) answer(true, result)
      else
        Promise.resolve(result).then(
          (value) => answer(true, value),
          (error) => answer(false, error),
        )
    } catch (error) {
      answer(false, error)
    }
  }

  function close(reason = new Error("Extension RPC closed."), notify = true) {
    if (state.closed) return
    if (notify) send({ rpc: true, type: "close", reason: encode(reason) })
    state.closed = reason
    port.off("message", onMessage)
    state.response?.close()
    for (const held of pending.values()) held.reject(reason)
    pending.clear()
    for (const controller of controllers.values()) controller.deref()?.abort(reason)
    controllers.clear()
    for (const { signal, abort } of listeners.values()) signal.removeEventListener("abort", abort)
    listeners.clear()
    references.clear()
    proxies.clear()
    leases.clear()
    retained.clear()
  }

  port.on("message", onMessage)
  if (blocking) {
    const channel = new Channel()
    state.response = channel.port1
    port.postMessage({ rpc: true, type: "connect", port: channel.port2 }, [channel.port2])
  }
  return {
    root: blocking ? proxy({ type: "reference", side: opposite, id: 0, kind: "object", fields: [], keys: [] }) : root,
    close,
  }
}
