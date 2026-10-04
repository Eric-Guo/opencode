import { expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/solid-virtual"
import { Node, Window } from "happy-dom"
import { observeElementOffsetReconnectAware } from "./observe-element-offset"

test("restores a view observed before its first attachment", async () => {
  const targetWindow = new Window()
  const mutations = controlledMutations(targetWindow)
  const viewport = targetWindow.document.createElement("div")

  const instance = virtualizer({
    scrollElement: viewport,
    targetWindow,
    scrollOffset: 240,
    options: { horizontal: false, isRtl: false, isScrollingResetDelay: 0, useScrollendEvent: false },
  })

  const connections: boolean[] = []

  const cleanup = observeElementOffsetReconnectAware(
    instance,
    (offset) => {
      instance.scrollOffset = offset
    },
    () => connections.push(viewport.isConnected),
  )

  try {
    mutations.append(targetWindow.document.body, viewport)
    await frames(2, targetWindow)
    expect(connections).toEqual([true])
    expect(instance.scrollOffset).toBe(0)
  } finally {
    cleanup()
    await targetWindow.happyDOM.close()
  }
})

test("reports a divergent native offset once and ignores equal offsets and unrelated mutations", async () => {
  const targetWindow = new Window()
  const mutations = controlledMutations(targetWindow)
  const route = targetWindow.document.createElement("section")
  const viewport = targetWindow.document.createElement("div")
  const unrelated = targetWindow.document.createElement("div")
  route.append(viewport)
  targetWindow.document.body.append(route)

  const instance = virtualizer({
    scrollElement: viewport,
    targetWindow,
    scrollOffset: 79_400,
    options: {
      horizontal: false,
      isRtl: false,
      isScrollingResetDelay: 0,
      useScrollendEvent: false,
    },
  })

  const calls: [number, boolean][] = []

  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })

  try {
    mutations.append(targetWindow.document.body, unrelated)
    mutations.remove(unrelated)
    expect(calls).toEqual([])

    mutations.remove(route)
    mutations.append(targetWindow.document.body, route)
    await frames(2, targetWindow)
    expect(calls).toEqual([[0, false]])

    mutations.remove(route)
    mutations.append(targetWindow.document.body, route)
    await frames(2, targetWindow)
    expect(calls).toEqual([[0, false]])
  } finally {
    cleanup?.()
    await targetWindow.happyDOM.close()
  }
})

test("keeps checking until stale reset-delay callbacks can no longer win", async () => {
  const targetWindow = new Window()
  const mutations = controlledMutations(targetWindow)
  const animation = controlledAnimationFrames(targetWindow)
  const route = targetWindow.document.createElement("section")
  const viewport = targetWindow.document.createElement("div")
  route.append(viewport)
  targetWindow.document.body.append(route)

  const instance = virtualizer({
    scrollElement: viewport,
    targetWindow,
    scrollOffset: 79_400,
    options: {
      horizontal: false,
      isRtl: false,
      isScrollingResetDelay: 20,
      useScrollendEvent: false,
    },
  })

  const calls: number[] = []

  const cleanup = observeElementOffsetReconnectAware(instance, (offset) => {
    calls.push(offset)
    instance.scrollOffset = offset
  })

  try {
    mutations.remove(route)
    mutations.append(targetWindow.document.body, route)
    animation.run(16)
    expect(instance.scrollOffset).toBe(0)

    instance.scrollOffset = 79_400
    animation.run(32)
    animation.run(48)

    expect(instance.scrollOffset).toBe(0)
    expect(calls).toEqual([0, 0])
    expect(animation.pending()).toBe(0)
  } finally {
    cleanup?.()
    await targetWindow.happyDOM.close()
  }
})

test("cleanup suppresses queued delegated callbacks, reconnect checks, and later scrolls", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)

  const instance = virtualizer({
    scrollElement: viewport,
    targetWindow: window,
    scrollOffset: 0,
    options: {
      horizontal: false,
      isRtl: false,
      isScrollingResetDelay: 10,
      useScrollendEvent: false,
    },
  })

  const calls: [number, boolean][] = []

  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  viewport.scrollTop = 100
  viewport.dispatchEvent(new Event("scroll"))
  cleanup?.()
  viewport.dispatchEvent(new Event("scroll"))
  await new Promise((resolve) => setTimeout(resolve, 25))
  await frames(4)

  expect(calls).toEqual([[100, true]])
  route.remove()
})

type FrameWindow = {
  requestAnimationFrame(callback: () => void): number | ReturnType<Window["requestAnimationFrame"]>
  performance: { now(): number }
}

async function frames(count: number, targetWindow: FrameWindow = window) {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => targetWindow.requestAnimationFrame(() => resolve()))
  }
}

function controlledMutations(targetWindow: Window) {
  let emit: (record: ChildListMutation) => void = () => {
    throw new Error("Mutation observer is not active")
  }

  class ControlledMutationObserver {
    constructor(callback: (records: ChildListMutation[]) => void) {
      emit = (record) => callback([record])
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }

  Object.defineProperty(targetWindow, "MutationObserver", { value: ControlledMutationObserver })

  const record = (target: Node, addedNodes: Node[], removedNodes: Node[]): ChildListMutation => ({
    type: "childList",
    target,
    addedNodes,
    removedNodes,
  })

  return {
    append(parent: Node, node: Node) {
      parent.appendChild(node)
      emit(record(parent, [node], []))
    },
    remove(node: Node) {
      const parent = node.parentNode

      if (!parent) throw new Error("Mutation target has no parent")
      parent.removeChild(node)
      emit(record(parent, [], [node]))
    },
  }
}

function controlledAnimationFrames(targetWindow: Window) {
  let time = 0
  let id = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  Object.defineProperty(targetWindow.performance, "now", { value: () => time })
  Object.defineProperty(targetWindow, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) => {
      id += 1
      callbacks.set(id, callback)

      return id
    },
  })
  Object.defineProperty(targetWindow, "cancelAnimationFrame", {
    value: (frame: number) => callbacks.delete(frame),
  })

  return {
    run(at: number) {
      time = at
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach((callback) => callback(at))
    },
    pending: () => callbacks.size,
  }
}

type ChildListMutation = { type: "childList"; target: Node; addedNodes: Node[]; removedNodes: Node[] }

function virtualizer(input: {
  scrollElement: Element | Node
  targetWindow: Window | typeof window
  scrollOffset: number
  options: Pick<
    Virtualizer<HTMLDivElement, HTMLDivElement>["options"],
    "horizontal" | "isRtl" | "isScrollingResetDelay" | "useScrollendEvent"
  >
}) {
  if (input.scrollElement.nodeName !== "DIV") throw new Error("A div viewport is required")

  const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => null,
    estimateSize: () => 1,
    scrollToFn() {},
    observeElementRect() {},
    observeElementOffset() {},
    ...input.options,
  })

  // SAFETY: The fixture creates a DIV in either the browser or Happy DOM realm; both implement the viewport DOM APIs used by the real observer.
  instance.scrollElement = input.scrollElement as HTMLDivElement
  // SAFETY: Happy DOM implements the browser window's observer, animation-frame and timer APIs; this bridge preserves that isolated realm rather than replacing its methods.
  instance.targetWindow = input.targetWindow as Virtualizer<HTMLDivElement, HTMLDivElement>["targetWindow"]
  instance.scrollOffset = input.scrollOffset

  return instance
}
