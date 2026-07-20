import type { ExternalDesktopTab } from "./desktop-tabs"

export const clipboardWritePermission = "clipboard-sanitized-write"

const permissions = new Set([
  clipboardWritePermission,
  "local-network-access",
  "local-network",
  "loopback-network",
])
const ssoOrigin = "https://sso.thape.com.cn"

export function isExternalTabURL(tab: Pick<ExternalDesktopTab, "url">, value?: string) {
  if (!value || !URL.canParse(value)) return false
  const target = new URL(value).origin
  return target === ssoOrigin || isConfiguredOrigin(tab, target)
}

export function createExternalTabNavigationHandler(
  tab: Pick<ExternalDesktopTab, "url">,
  openExternal: (url: string) => void,
) {
  return (event: { preventDefault(): void }, url: string) => {
    if (isExternalTabURL(tab, url)) return
    event.preventDefault()
    openExternal(url)
  }
}

export function isExternalTabPermissionAllowed(
  tab: Pick<ExternalDesktopTab, "url" | "localServer">,
  permission: string,
  requestingURL?: string,
) {
  if (!requestingURL || !URL.canParse(requestingURL)) return false
  return Boolean(tab.localServer && permissions.has(permission) && isConfiguredOrigin(tab, new URL(requestingURL).origin))
}

function isConfiguredOrigin(tab: Pick<ExternalDesktopTab, "url">, origin: string) {
  const configured = new URL(tab.url).origin
  return configured !== "null" && origin === configured
}
