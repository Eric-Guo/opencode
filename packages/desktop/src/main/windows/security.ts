import type { Session, WebContents } from "electron"
import { SidecarCredentials } from "../service/sidecar-credentials"
import { addRendererHeaders, hasHeader, upsertHeader } from "./headers"
import { isRendererUrl } from "./protocol"

const rendererPermissions = new Set(["clipboard-sanitized-write", "notifications"])

const trustedContents = new WeakMap<Session, Set<number>>()

export function allowRendererPermissions(contents: WebContents) {
  const existing = trustedContents.get(contents.session)
  const clients = existing ?? new Set<number>()
  clients.add(contents.id)
  contents.once("destroyed", () => clients.delete(contents.id))
  if (existing) return
  trustedContents.set(contents.session, clients)
  contents.session.setPermissionRequestHandler((sender, permission, callback, details) => {
    callback(clients.has(sender.id) && rendererPermissions.has(permission) && isRendererUrl(details.requestingUrl))
  })
  contents.session.setPermissionCheckHandler((sender, permission, origin, details) => {
    return (
      !!sender &&
      clients.has(sender.id) &&
      rendererPermissions.has(permission) &&
      (isRendererUrl(details.requestingUrl) || isRendererUrl(origin))
    )
  })
}

export function wireNavigationPolicy(contents: WebContents, openExternalURL: (url: string) => unknown) {
  contents.setWindowOpenHandler(({ url }) => {
    if (!isRendererUrl(url)) openExternalURL(url)
    return { action: "deny" }
  })
  contents.on("will-navigate", (event, url) => {
    if (isRendererUrl(url)) return
    event.preventDefault()
    openExternalURL(url)
  })
}

export function wireRendererHeaders(contents: WebContents) {
  // The renderer sends sidecar requests without credentials, so its GETs are CORS-simple and need no
  // preflight. Electron applies these listeners in Chromium's extraHeaders mode, after the CORS
  // decision, so adding Authorization here does not reintroduce one.
  //
  // Only the renderer's own top-level frame is credentialed. Other content in this session (web views,
  // embedded pages) can reach the same loopback origin and must not inherit its access. Requests with
  // no frame, such as from a service worker, are not credentialed either; the renderer registers none.
  contents.session.webRequest.onBeforeSendHeaders(
    { urls: ["http://127.0.0.1/*", "http://localhost/*"] },
    (details, callback) => {
      const frame = details.frame
      const renderer = !!frame && frame.parent === null && isRendererUrl(frame.url)
      const authorization = renderer && SidecarCredentials.authorization(SidecarCredentials.get(), details.url)
      if (authorization && !hasHeader(details.requestHeaders, "Authorization")) {
        upsertHeader(details.requestHeaders, "Authorization", authorization)
      }
      callback({ requestHeaders: details.requestHeaders })
    },
  )
  contents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {}
    addRendererHeaders(responseHeaders, { document: isRendererUrl(details.url, true) })
    callback({ responseHeaders })
  })
}
