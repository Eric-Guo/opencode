# Optional desktop extensions

Select a trusted build-time extension with `OPENCODE_DESKTOP_EXTENSION=/path/to/checkout`. Omit it, or set it to `none`, to build the base desktop. This is a distribution composition seam, not a runtime marketplace or an untrusted plugin loader.

The checkout supplies a `desktop-extension.json` manifest with `apiVersion: 1`, `main`, `preload`, `renderer`, `preloads` (entry name to source path), and `assets` (output-relative path to source path). All source paths are relative to the manifest directory. Renderer files are served during development and copied into `out/renderer` during builds; directory assets are copied for builds and can use their own development server. Electron's packager consumes only the resulting output.

The public type-only API is exported as `@opencode/desktop/extension` from `src/extension.ts`. The main module exports a `DesktopExtension`; the renderer module exports a `DesktopRendererExtension`; the preload module installs the extension's own limited bridge.

The host calls initialization after the desktop environment and Electron are ready, before service discovery. Optional service CORS contributions apply only during initial service discovery. A window extension returns its primary content, active content accessor, optional native content root, disposal, and optional permanent-close cleanup. Native browser panes use that root so their bounds and visibility follow the primary tab. The host continues to own recovery, native window controls, main-renderer IPC, state storage, and shutdown. Window state is retained during application quit.

Extensions create trusted bundled renderers through `createRenderer`; only these receive the normal desktop RPC bridge. External contents use `trackContents` for window ownership without receiving that bridge. Extension IPC handlers are registered and disposed centrally by `src/main/ipc.ts`. Extensions must validate their own sender, frame, origin, and payload boundaries; registration does not grant every renderer access.

Initialization can carry extension-owned fields while the normal sidecar boundary still omits the Basic credential. The legacy `AppGetCybrosCurrentUser` RPC is a compatibility forwarder for existing 7777 builds; its implementation lives in the optional extension. The generic account dialog and navigation/menu surfaces remain host-owned.

The SigmaAgents implementation is maintained in the separate sibling checkout `packages/desktop-tab`. See that repository's README for configuration and distribution commands. Changes to the generic CLI CORS configuration and reconnect behavior from the original 16 commits remain in their owning packages. Pre-existing THAPE resource packaging and core SSO support are outside this extraction.
