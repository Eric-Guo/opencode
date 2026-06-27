import { expect, type CDPSession, type Page, type TestInfo } from "@playwright/test"
import { writeFile } from "node:fs/promises"

export type VisualRegionSample = {
  present: boolean
  visible: boolean
  inViewport: boolean
  cssHidden?: boolean
  top: number
  bottom: number
  layoutTop?: number
  layoutBottom?: number
  width: number
  height: number
  opacity: number
  count: number
  node: number
  label: string
  text: string
}

export type VisualStabilityTrace = {
  markers: { at: number; label: string }[]
  samples: {
    at: number
    regions: Record<string, VisualRegionSample>
    viewport?: {
      top: number
      bottom: number
      scrollTop: number
      scrollHeight: number
      clientHeight: number
      distanceFromBottom: number
    }
  }[]
}

type ProbeRegion = {
  selector: string
  closest?: string
  opacitySelectors?: string[]
}

type ProbeWindow = Window & {
  __visualStabilityProbe?: VisualStabilityTrace & { startedAt: number; stop: () => void }
}

type CapturedFrame = { at: number; data: string }
const capturedFrames = Symbol("capturedFrames")
const recordings = new WeakMap<
  Page,
  { session: CDPSession; frames: CapturedFrame[]; startedAtEpoch: number; running: boolean; capture: Promise<void> }
>()

export async function startVisualStabilityProbe(page: Page, regions: Record<string, ProbeRegion>) {
  await stopRecording(page)
  await page.evaluate(() => {
    ;(window as ProbeWindow).__visualStabilityProbe?.stop()
  })
  const capture = process.env.OPENCODE_STABILITY_CAPTURE === "1"
  const session = capture ? await page.context().newCDPSession(page) : undefined
  const frames: CapturedFrame[] = []
  if (session) await session.send("Page.enable")
  const startedAtEpoch = await page
    .evaluate((regions) => {
      const samples: VisualStabilityTrace["samples"] = []
      const markers: VisualStabilityTrace["markers"] = []
      const startedAt = performance.now()
      const nodes = new WeakMap<Node, number>()
      const lastBounds = new Map<string, { top: number; bottom: number }>()
      let nextNode = 1
      let running = true
      const round = (value: number) => Math.round(value * 10) / 10
      const opacity = (element: Element) => Number(getComputedStyle(element).opacity)
      const sample = () => {
        if (!running) return
        setTimeout(() => {
          if (!running) return
          const viewport = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
            element.querySelector("[data-timeline-row]"),
          )
          const viewportRect = viewport?.getBoundingClientRect()
          samples.push({
            at: performance.now() - startedAt,
            viewport: viewport
              ? {
                  top: round(viewportRect!.top),
                  bottom: round(viewportRect!.bottom),
                  scrollTop: round(viewport.scrollTop),
                  scrollHeight: round(viewport.scrollHeight),
                  clientHeight: round(viewport.clientHeight),
                  distanceFromBottom: round(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
                }
              : undefined,
            regions: Object.fromEntries(
              Object.entries(regions).map(([name, config]) => {
                const found = document.querySelector<HTMLElement>(config.selector)
                const count = document.querySelectorAll(config.selector).length
                const element = config.closest ? found?.closest<HTMLElement>(config.closest) : found
                if (!element)
                  return [
                    name,
                    {
                      present: false,
                      visible: false,
                      inViewport: false,
                      top: 0,
                      bottom: 0,
                      width: 0,
                      height: 0,
                      opacity: 0,
                      count,
                      node: 0,
                      label: "",
                      text: "",
                    },
                  ]
                const rect = element.getBoundingClientRect()
                const style = getComputedStyle(element)
                if (rect.height > 0) lastBounds.set(name, { top: rect.top, bottom: rect.bottom })
                const known = rect.height > 0 ? rect : lastBounds.get(name)
                const painted = (() => {
                  const result = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
                  let parent = element.parentElement
                  while (parent) {
                    const parentStyle = getComputedStyle(parent)
                    if (["hidden", "clip", "scroll", "auto"].includes(parentStyle.overflowY)) {
                      const parentRect = parent.getBoundingClientRect()
                      result.top = Math.max(result.top, parentRect.top)
                      result.bottom = Math.min(result.bottom, parentRect.bottom)
                    }
                    if (["hidden", "clip", "scroll", "auto"].includes(parentStyle.overflowX)) {
                      const parentRect = parent.getBoundingClientRect()
                      result.left = Math.max(result.left, parentRect.left)
                      result.right = Math.min(result.right, parentRect.right)
                    }
                    if (parent === viewport) break
                    parent = parent.parentElement
                  }
                  if (viewportRect) {
                    result.top = Math.max(result.top, viewportRect.top)
                    result.bottom = Math.min(result.bottom, viewportRect.bottom)
                    result.left = Math.max(result.left, viewportRect.left)
                    result.right = Math.min(result.right, viewportRect.right)
                  }
                  return result
                })()
                const contentOpacity = config.opacitySelectors?.length
                  ? Math.max(
                      0,
                      ...config.opacitySelectors.flatMap((selector) =>
                        [...element.querySelectorAll(selector)].map((node) => {
                          let value = 1
                          let current: Element | null = node
                          while (current) {
                            value *= opacity(current)
                            if (current === element) break
                            current = current.parentElement
                          }
                          return value
                        }),
                      ),
                    )
                  : opacity(element)
                let visibleOpacity = contentOpacity
                let ancestor = element.parentElement
                let ancestorHidden = false
                while (ancestor) {
                  const ancestorStyle = getComputedStyle(ancestor)
                  visibleOpacity *= Number(ancestorStyle.opacity)
                  if (ancestorStyle.display === "none" || ancestorStyle.visibility === "hidden") ancestorHidden = true
                  if (ancestor === viewport) break
                  ancestor = ancestor.parentElement
                }
                const cssHidden =
                  ancestorHidden || style.display === "none" || style.visibility === "hidden" || visibleOpacity === 0
                return [
                  name,
                  {
                    present: true,
                    visible:
                      style.display !== "none" &&
                      style.visibility !== "hidden" &&
                      visibleOpacity > 0 &&
                      painted.right > painted.left &&
                      painted.bottom > painted.top,
                    inViewport:
                      !viewportRect || (!!known && known.bottom > viewportRect.top && known.top < viewportRect.bottom),
                    cssHidden,
                    top: round(painted.top),
                    bottom: round(painted.bottom),
                    layoutTop: round(rect.top),
                    layoutBottom: round(rect.bottom),
                    width: round(painted.right - painted.left),
                    height: round(painted.bottom - painted.top),
                    opacity: round(visibleOpacity),
                    count,
                    node: (() => {
                      const current = nodes.get(element)
                      if (current) return current
                      nodes.set(element, nextNode)
                      return nextNode++
                    })(),
                    label: element.getAttribute("aria-label") ?? "",
                    text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500),
                  },
                ]
              }),
            ),
          })
          requestAnimationFrame(sample)
        }, 0)
      }
      ;(window as ProbeWindow).__visualStabilityProbe = {
        startedAt,
        markers,
        samples,
        stop: () => {
          running = false
        },
      }
      requestAnimationFrame(sample)
      return new Promise<number>((resolve) => {
        const ready = () => {
          if (samples.length > 0) return resolve(performance.timeOrigin + startedAt)
          requestAnimationFrame(ready)
        }
        ready()
      })
    }, regions)
    .catch(async (error) => {
      if (session) await session.detach().catch(() => undefined)
      throw error
    })
  if (!session) return
  const recording = {
    session,
    frames,
    startedAtEpoch,
    running: true,
    capture: Promise.resolve(),
  }
  recording.capture = (async () => {
    try {
      while (recording.running && recording.frames.length < 900) {
        const frame = await session.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 80,
          captureBeyondViewport: false,
          optimizeForSpeed: true,
        })
        recording.frames.push({ at: Date.now() - recording.startedAtEpoch, data: frame.data })
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } catch {
      recording.running = false
    }
  })()
  recordings.set(page, recording)
}

export async function stopVisualStabilityProbe(page: Page) {
  let frames: CapturedFrame[] = []
  const trace = await page
    .evaluate(() => {
      const probe = (window as ProbeWindow).__visualStabilityProbe
      if (!probe) throw new Error("Visual stability probe is not running")
      probe.stop()
      return { markers: probe.markers, samples: probe.samples }
    })
    .finally(async () => {
      frames = await stopRecording(page)
    })
  Object.defineProperty(trace, capturedFrames, { value: frames })
  return trace
}

async function stopRecording(page: Page) {
  const recording = recordings.get(page)
  if (!recording) return []
  recordings.delete(page)
  recording.running = false
  try {
    await recording.capture
  } finally {
    await recording.session.detach().catch(() => undefined)
  }
  return recording.frames
}

export async function markVisualStability(page: Page, label: string) {
  await page.evaluate((label) => {
    const probe = (window as ProbeWindow).__visualStabilityProbe
    if (!probe) return
    probe.markers.push({ at: performance.now() - probe.startedAt, label })
  }, label)
}

export async function expectVisualStability(
  testInfo: TestInfo,
  name: string,
  trace: VisualStabilityTrace,
  options: Parameters<typeof analyzeVisualStability>[1] = {},
) {
  const issues = options.perMarker
    ? analyzeVisualStabilityByMarker(trace, options)
    : analyzeVisualStability(trace, options)
  const frames = readCapturedFrames(trace)
  const tracePath = testInfo.outputPath(`${name}-visual-trace.json`)
  const issuesPath = testInfo.outputPath(`${name}-visual-issues.json`)
  await writeFile(tracePath, JSON.stringify(trace, null, 2))
  await writeFile(
    issuesPath,
    JSON.stringify({ issues, markers: trace.markers, capturedFrameCount: frames.length }, null, 2),
  )
  await testInfo.attach(`${name}-visual-trace`, {
    path: tracePath,
    contentType: "application/json",
  })
  await testInfo.attach(`${name}-visual-issues`, {
    path: issuesPath,
    contentType: "application/json",
  })
  if (issues.length) await attachViolationFrames(testInfo, name, trace, issues)
  expect(issues, `${name}: ${issues.join("\n")}`).toEqual([])
}

async function attachViolationFrames(testInfo: TestInfo, name: string, trace: VisualStabilityTrace, issues: string[]) {
  const frames = readCapturedFrames(trace)
  if (frames.length === 0) return
  const targets = [
    ...new Set(
      issues.flatMap((issue) => {
        const match = issue.match(/ at (\d+)ms/)
        if (match) return [Number(match[1])]
        const marker = trace.markers.find((item) => issue.startsWith(`${item.label}:`))
        return marker ? [marker.at] : []
      }),
    ),
  ].slice(0, 6)
  for (const [violation, target] of targets.entries()) {
    const nearest = frames.reduce(
      (best, frame, index) => (Math.abs(frame.at - target) < Math.abs(frames[best]!.at - target) ? index : best),
      0,
    )
    for (const [label, index] of [
      ["before", Math.max(0, nearest - 1)],
      ["violation", nearest],
      ["after", Math.min(frames.length - 1, nearest + 1)],
    ] as const) {
      await testInfo.attach(`${name}-${violation + 1}-${label}-${Math.round(frames[index]!.at)}ms`, {
        body: Buffer.from(frames[index]!.data, "base64"),
        contentType: "image/jpeg",
      })
    }
  }
}

function readCapturedFrames(trace: VisualStabilityTrace) {
  return (trace as VisualStabilityTrace & { [capturedFrames]?: CapturedFrame[] })[capturedFrames] ?? []
}

export function analyzeVisualStability(
  trace: VisualStabilityTrace,
  options: {
    flow?: string[]
    motionTolerance?: number
    opacityFloor?: number
    overlapTolerance?: number
    maxReversals?: number
    maxPositionReversals?: number
    stable?: string[]
    fixed?: string[]
    motion?: string[]
    unique?: string[]
    preserveBottomAnchor?: boolean
    acquireBottomAnchor?: boolean
    perMarker?: boolean
    continuousAny?: string[][]
    required?: string[]
  } = {},
) {
  const issues: string[] = []
  const motionTolerance = options.motionTolerance ?? 1
  const opacityFloor = options.opacityFloor ?? 0.65
  const overlapTolerance = options.overlapTolerance ?? 0.5
  const maxReversals = options.maxReversals ?? 1
  const maxPositionReversals = options.maxPositionReversals ?? maxReversals
  const names = [...new Set(trace.samples.flatMap((sample) => Object.keys(sample.regions)))]

  for (const name of options.required ?? []) {
    if (!trace.samples.some((sample) => sample.regions[name]?.visible)) issues.push(`${name} never rendered`)
  }

  for (const name of names) {
    const samples = trace.samples.flatMap((sample) => {
      const region = sample.regions[name]
      if (!region) return []
      const clipped = sample.viewport && (region.bottom <= sample.viewport.top || region.top >= sample.viewport.bottom)
      return [{ at: sample.at, ...region, visible: region.visible && !clipped }]
    })
    const visible = samples.filter((sample) => sample.visible)
    if (visible.length === 0) continue
    if (options.unique?.includes(name)) {
      const duplicate = samples.find((sample) => sample.count > 1)
      if (duplicate) issues.push(`${name} appeared ${duplicate.count} times at ${Math.round(duplicate.at)}ms`)
    }
    if (options.stable?.includes(name)) {
      const identities = [...new Set(visible.map((sample) => sample.node).filter((node) => node > 0))]
      if (identities.length > 1) issues.push(`${name} remounted ${identities.length - 1} times`)
    }
    if (options.fixed?.includes(name)) {
      const origin = visible[0]
      const movement = origin ? Math.max(0, ...visible.map((sample) => Math.abs(sample.top - origin.top))) : 0
      if (movement > motionTolerance) issues.push(`${name} moved ${Math.round(movement * 10) / 10}px in the viewport`)
    }
    for (const sample of visible) {
      if (sample.opacity < opacityFloor)
        issues.push(`${name} opacity fell to ${sample.opacity} at ${Math.round(sample.at)}ms`)
    }
    const firstPresent = samples.findIndex((sample) => sample.present)
    const lastPresent = samples.findLastIndex((sample) => sample.present)
    if (samples.slice(firstPresent, lastPresent + 1).some((sample) => !sample.present))
      issues.push(`${name} disappeared between present frames`)
    const firstVisible = samples.findIndex((sample) => sample.visible)
    const lastVisible = samples.findLastIndex((sample) => sample.visible)
    if (
      firstVisible >= 0 &&
      samples.slice(firstVisible, lastVisible + 1).some((sample) => !sample.visible && sample.inViewport)
    )
      issues.push(`${name} blanked between visible frames`)

    for (const metric of options.motion && !options.motion.includes(name)
      ? []
      : (["top", "bottom", "width", "height"] as const)) {
      const directions = visible
        .slice(1)
        .map((sample, index) => sample[metric] - visible[index]![metric])
        .filter((delta) => Math.abs(delta) > motionTolerance)
        .map(Math.sign)
      const reversals = directions.slice(1).filter((direction, index) => direction !== directions[index]).length
      const allowed = metric === "top" || metric === "bottom" ? maxPositionReversals : maxReversals
      if (reversals > allowed) issues.push(`${name} ${metric} reversed ${reversals} times`)
    }

    const labels = samples
      .map((sample) => sample.label)
      .filter((label) => label.length > 0)
      .filter((label, index, all) => label !== all[index - 1])
    if (labels.some((label, index) => labels.indexOf(label) !== index))
      issues.push(`${name} label reverted: ${labels.join(" -> ")}`)
  }

  if (options.preserveBottomAnchor) {
    const viewports = trace.samples.flatMap((sample) => (sample.viewport ? [sample.viewport] : []))
    if (viewports[0] && viewports[0].distanceFromBottom <= 4) {
      const lost = viewports.find((viewport) => viewport.distanceFromBottom > 4)
      if (lost) issues.push(`bottom anchor moved to ${lost.distanceFromBottom}px`)
    }
  }
  if (options.acquireBottomAnchor) {
    const final = trace.samples.findLast((sample) => sample.viewport)?.viewport
    if (!final || final.distanceFromBottom > 4)
      issues.push(`did not acquire bottom anchor${final ? ` (${final.distanceFromBottom}px away)` : ""}`)
  }

  for (const group of options.continuousAny ?? []) {
    const active = trace.samples.map((sample) => group.some((name) => sample.regions[name]?.visible))
    const first = active.indexOf(true)
    const last = active.lastIndexOf(true)
    if (first >= 0 && active.slice(first, last + 1).some((value) => !value))
      issues.push(`${group.join(" | ")} blanked between visible frames`)
  }

  for (const [before, after] of (options.flow ?? []).slice(1).map((after, index) => [options.flow![index]!, after])) {
    let maximum: { overlap: number; at: number } | undefined
    let inverted: { at: number } | undefined
    for (const sample of trace.samples) {
      const first = sample.regions[before]
      const second = sample.regions[after]
      if (!first?.visible || !second?.visible) continue
      if (
        sample.viewport &&
        (first.bottom <= sample.viewport.top ||
          first.top >= sample.viewport.bottom ||
          second.bottom <= sample.viewport.top ||
          second.top >= sample.viewport.bottom)
      )
        continue
      const overlap = first.bottom - second.top
      if (first.top > second.top && !inverted) inverted = { at: sample.at }
      if (overlap > overlapTolerance && (!maximum || overlap > maximum.overlap)) maximum = { overlap, at: sample.at }
    }
    if (inverted) issues.push(`${before} rendered after ${after} at ${Math.round(inverted.at)}ms`)
    if (maximum)
      issues.push(
        `${before} overlapped ${after} by ${Math.round(maximum.overlap * 10) / 10}px at ${Math.round(maximum.at)}ms`,
      )
  }

  return [...new Set(issues)]
}

export function analyzeVisualStabilityByMarker(
  trace: VisualStabilityTrace,
  options: Parameters<typeof analyzeVisualStability>[1] = {},
) {
  if (trace.markers.length === 0) return analyzeVisualStability(trace, options)
  const required = (options.required ?? []).flatMap((name) =>
    trace.samples.some((sample) => sample.regions[name]?.visible) ? [] : [`${name} never rendered`],
  )
  const windows = trace.markers.flatMap((marker, index) => {
    const end = trace.markers[index + 1]?.at ?? Infinity
    const before = trace.samples.findLast((sample) => sample.at < marker.at)
    const samples = [
      ...(before ? [before] : []),
      ...trace.samples.filter((sample) => sample.at >= marker.at && sample.at < end),
    ]
    if (samples.length < 2) return []
    return analyzeVisualStability(
      { markers: [marker], samples },
      { ...options, perMarker: false, required: undefined },
    ).map((issue) => `${marker.label}: ${issue}`)
  })
  return [...required, ...windows]
}
