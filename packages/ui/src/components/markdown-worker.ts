import MarkdownShikiWorkerUrl from "./markdown-shiki.worker.ts?worker&url"
import { OpenCodeTheme } from "../context/marked"
import {
  applyMarkdownWorkerResponse,
  shouldReleaseMarkdownWorkerState,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
  type MarkdownWorkerState,
} from "./markdown-worker-protocol"

type Pending = {
  key: string
  complete: boolean
  resolve: (state: MarkdownWorkerState) => void
  reject: (error: Error) => void
}

let worker: Worker | undefined
let nextID = 0
const pending = new Map<number, Pending>()
const states = new Map<string, MarkdownWorkerState>()
const keys = new Set<string>()
const latest = new Map<string, number>()

export function highlightStreamingCode(key: string, text: string, language: string, complete = false) {
  const instance = getWorker()
  const id = ++nextID
  latest.set(key, id)
  keys.delete(key)
  keys.add(key)
  if (keys.size > 200) disposeStreamingCode(keys.values().next().value!)
  return new Promise<MarkdownWorkerState>((resolve, reject) => {
    pending.set(id, { key, complete, resolve, reject })
    instance.postMessage({ type: "highlight", id, key, text, language, complete } satisfies MarkdownWorkerRequest)
  })
}

export function disposeStreamingCode(key: string) {
  keys.delete(key)
  latest.delete(key)
  states.delete(key)
  pending.forEach((request, id) => {
    if (request.key !== key) return
    pending.delete(id)
    request.reject(new MarkdownWorkerDisposedError())
  })
  worker?.postMessage({ type: "dispose", key } satisfies MarkdownWorkerRequest)
}

export class MarkdownWorkerDisposedError extends Error {}
export class MarkdownWorkerSupersededError extends Error {}

function getWorker() {
  if (worker) return worker
  worker = new Worker(MarkdownShikiWorkerUrl, { type: "module" })
  worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
    const result = pending.get(event.data.id)
    if (!result) return
    pending.delete(event.data.id)
    if (!keys.has(event.data.key)) {
      result.reject(new MarkdownWorkerDisposedError())
      return
    }
    if (event.data.type === "superseded") {
      result.reject(new MarkdownWorkerSupersededError())
      return
    }
    if (event.data.type === "error") {
      result.reject(new Error(event.data.message))
      return
    }
    const state = applyMarkdownWorkerResponse(states.get(event.data.key), event.data)
    if (shouldReleaseMarkdownWorkerState(result.complete, latest.get(event.data.key), event.data.id)) {
      states.delete(event.data.key)
      keys.delete(event.data.key)
      latest.delete(event.data.key)
    } else states.set(event.data.key, state)
    result.resolve(state)
  }
  const fail = (message: string) => {
    const error = new Error(message)
    pending.forEach((request) => request.reject(error))
    pending.clear()
    states.clear()
    keys.clear()
    latest.clear()
    worker?.terminate()
    worker = undefined
  }
  worker.onerror = (event) => fail(event.message || "Markdown highlighting worker failed")
  worker.onmessageerror = () => fail("Markdown worker response failed")
  worker.postMessage({ type: "init", theme: OpenCodeTheme } satisfies MarkdownWorkerRequest)
  return worker
}
