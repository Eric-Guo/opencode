import type { BrowserWindow, IpcMainInvokeEvent, WebContents, WebContentsView, View } from "electron"

/** Versioned, type-only contract. Extensions must not import desktop internals. */
export type DesktopExtensionStore = {
  get(name: string, key: string): string | null
  set(name: string, key: string, value: string): void
  clear(name: string): void
}
export type DesktopWindowHost = {
  window: BrowserWindow
  id: string
  preloadRoot: string
  storage: DesktopExtensionStore
  createRenderer(options: { id: string; html: string; devURL?: string | false; devHtml?: string }): WebContentsView
  trackContents(contents: WebContents): void
  load(contents: WebContents, html: string): Promise<void>
  openExternal(url: string): void
  command(id: string): void
  setControlColor(color?: string): void
  log(message: string, error?: unknown): void
}
export type DesktopWindowExtension = {
  primary: WebContents
  /** Native content such as browser panes uses this root so it follows shell bounds and visibility. */
  contentView?: View
  active(): WebContents
  dispose(): void
  /** Called only when the window is permanently closed, never on application quit. */
  forget?(): void
}
export type DesktopExtension = {
  apiVersion: 1
  initialize?(): Promise<void>
  serviceCors?(): string[]
  request?(contents: WebContents, method: string, input?: unknown): Promise<unknown>
  rendererData?(contents: WebContents): Record<string, unknown>
  createWindow?(host: DesktopWindowHost): DesktopWindowExtension
  ipc?(host: {
    connection(): Promise<{ url: string; password: string | null }>
  }): Record<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>
}
export type DesktopRendererExtension = {
  setup?(host: { showLogin(onLogin: (credentials: { username: string; password: string }) => Promise<void>): void }): {
    command(id: string): boolean
  }
}
