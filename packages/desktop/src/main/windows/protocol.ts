import { net, protocol } from "electron"
import type { WebContents } from "electron"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { documentPolicyHeader, jsCallStacksDocumentPolicy } from "./headers"
import { rendererHost, rendererProtocol } from "./scheme"

const rendererOrigins = new Set<string>()

export function registerRendererOrigin(url?: string | false) {
  if (url && URL.canParse(url)) rendererOrigins.add(new URL(url).origin)
}

export type ProtocolReport = (level: "warning" | "error", message: string, data: Record<string, unknown>) => void

// The entry module registers the handler the moment the first window exists, before logging is up,
// so problems go to the console until the logging layer installs a reporter.
let report: ProtocolReport = (level, message, data) => console[level === "error" ? "error" : "warn"](message, data)

export function setProtocolReporter(reporter: ProtocolReport) {
  report = reporter
}

// Requests in flight and when the last one arrived. The entry module holds the main bundle back
// until the renderer's initial burst of asset requests has been answered, because this handler
// runs on the main thread and a 100 ms module evaluation would otherwise sit between the renderer
// and its HTML.
let inflight = 0
let served = 0
let lastRequest = 0

export function rendererAssetsServed(options: { quietMs: number; capMs: number }) {
  const start = Date.now()
  return new Promise<void>((resolve) => {
    const check = () => {
      const now = Date.now()
      if (now - start >= options.capMs) return resolve()
      if (served > 0 && inflight === 0 && now - lastRequest >= options.quietMs) return resolve()
      setTimeout(check, 5)
    }
    check()
  })
}

export function registerRendererProtocol(rendererRoot: string) {
  if (protocol.isProtocolHandled(rendererProtocol)) return

  protocol.handle(rendererProtocol, async (request) => {
    inflight++
    lastRequest = Date.now()
    try {
      return await serve(request, rendererRoot)
    } finally {
      inflight--
      served++
    }
  })
}

async function serve(request: Request, rendererRoot: string) {
  const url = new URL(request.url)
  if (url.host !== rendererHost) {
    report("warning", "rejected host", { url: request.url })
    return new Response("Not found", { status: 404 })
  }

  const file = path.resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
  const rel = path.relative(rendererRoot, file)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    report("warning", "rejected path", { url: request.url, file })
    return new Response("Not found", { status: 404 })
  }

  try {
    const range = request.headers.get("range")
    const response = await net.fetch(pathToFileURL(file).toString(), { headers: range ? { range } : undefined })
    if (response.status >= 400) {
      report("error", "fetch failed", {
        url: request.url,
        file,
        status: response.status,
        statusText: response.statusText,
      })
    }
    return addDocumentPolicy(response, file)
  } catch (error) {
    report("error", "fetch error", { url: request.url, file, error })
    return new Response("Not found", { status: 404 })
  }
}

export function loadWebContents(
  contents: WebContents,
  html: string,
  options: { devURL?: string | false; devHtml?: string } = {},
) {
  const devURL = options.devURL === false ? undefined : (options.devURL ?? process.env.ELECTRON_RENDERER_URL)
  if (devURL) return contents.loadURL(new URL(options.devHtml ?? html, devURL).toString())
  return contents.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}

export function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  if (rendererOrigins.has(url.origin)) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
}

function addDocumentPolicy(response: Response, file: string) {
  if (!file.toLowerCase().endsWith(".html")) return response
  const headers = new Headers(response.headers)
  headers.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
