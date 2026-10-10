# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

Development builds the CLI's Node bundle from source and runs the isolated background service with Node.
Install Node 26.8.2 or newer; set `NODE_BIN` to select a specific Node executable. Bun runs the build scripts.
The CLI bundle is rebuilt on each `bun run dev` invocation, while the desktop renderer keeps hot reload.

The host defaults to the base desktop. To start the SigmaAgents tab shell, run this from `packages/desktop`:

```bash
OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run dev
```

Alternatively, run `bun run dev` from `packages/desktop-tab`; its script selects the extension automatically. Development rebuilds from source, so a previous extension-enabled build does not select the extension for a later `dev` command. An environment variable prefixed to one command applies only to that command.

With an extension selected, `dev` runs its manifest's optional `builds` scripts and copies its assets into
`out/renderer` before starting Electron. Local tabs without their own development server therefore use freshly built
bundles. For renderer hot reload, run each renderer's dev server and set its tab-specific renderer URL.

## Build

`bun run build` prepares `resources/` (icons and metainfo) and builds the app into `out/`.
`bun run pack` then packages it, unsigned, into `dist/desktop/` at the repository root: a `.app` tarball on macOS,
the unpacked app on Windows, and AppImage/deb/rpm on Linux. The release workflow signs and notarizes afterwards.

```bash
bun run build && bun run pack
```

The desktop prebuild first runs every project/script pair in the selected extension's `desktop-extension.json`
`builds` map, in order, on every invocation. For `desktop-tab`, this rebuilds 7777 and plm-meeting together through
`plm-meeting`'s `build:shared` before preparing the embedded server sidecar and compiling Electron. Missing or stale
shared output needs no separate build command. A failed renderer build stops the desktop build. With no extension
selected, or `OPENCODE_DESKTOP_EXTENSION=none`, the base desktop skips these extension builds.

With the extension exported in your shell, the Windows x64 build steps remain:

```bash
export OPENCODE_DESKTOP_EXTENSION="<repo-root>/packages/desktop-tab"
cd "<repo-root>/packages/desktop"
RUST_TARGET=x86_64-pc-windows-msvc bun run build && \
RUST_TARGET=x86_64-pc-windows-msvc bun run package:win -- --x64 --publish never
```

See [Adding another Sigma agent](../desktop-tab/README.md#adding-another-sigma-agent) for shared build registration,
tab configuration, and release checks. Keep new bundled agent assets in the common `assets/` directory.

See [EXTENSIONS.md](./EXTENSIONS.md) for the optional desktop extension API and the separate `packages/desktop-tab` checkout's [README](../desktop-tab/README.md) for renderer prerequisites. To build and package the SigmaAgents tab shell for macOS, run these commands from `packages/desktop`, keeping the extension setting on both commands:

```bash
OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run build
OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run pack
```

Set `OPENCODE_TARGET` for the desired platform and architecture. Packaging consumes the current `out` directory, so build with the extension selected before packaging; setting the variable only on the packaging command does not rebuild a base desktop bundle into the tab version.

For production tab builds, also set `OPENCODE_CHANNEL=prod` on both commands:

```bash
OPENCODE_CHANNEL=prod OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run build
OPENCODE_CHANNEL=prod OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run pack
```

Both read the same environment as every other release package:

| Variable | Meaning |
| --- | --- |
| `OPENCODE_CHANNEL` | `dev` (default), `beta`, or `latest`/`prod`. Picks the app identity and icons. |
| `OPENCODE_VERSION` | Version stamped into the app and its packages. |
| `OPENCODE_TARGET` | `darwin-arm64`, `darwin-x64`, `windows-arm64`, `windows-x64`, `linux-x64`, `linux-arm64`. Defaults to the host. |

All channels build the embedded server sidecar from source, along with its assets.
The sidecar and its assets are included under `out/main` in the app archive. A separate CLI distribution is not required.

`bun dev` builds the Node CLI from source and starts the development renderer with the dev app identity.

## Beta channel

Every push to the `beta` branch publishes OpenCode Beta (`ai.opencode.desktop.beta`) as version `0.0.0-beta-<run>` to
the `beta` update channel. Beta publishes only the desktop app and `beta.opencode.ai`; the CLI and SDK packages ship
from `dev`. Install it from `https://opencode.ai/update/api/beta/desktop/opencode/<asset>`, for example
`opencode-desktop-mac-arm64.dmg` or `opencode-desktop-win-x64.exe`. Installed builds update in place on every platform.

Each beta build compiles in its commit and the `feat`, `fix` and `perf` commits among its newest 200
(`script/beta-notes.ts`, embedded by `electron.vite.config.ts`; run `bun script/beta-notes.ts` to preview them). After an
update, the beta app lists the ones after the commit of the build the user saw last in a "What's new in beta" dialog,
unless release notes are turned off in Settings.

## Startup benchmark

`perf/startup.bench.ts` times a launch with [strobe](https://github.com/Hona/strobe), from process spawn to what a
person waits for, in pairs of launches of two builds with an interval per case. Every launch runs in a private home
(its own `%APPDATA%`, XDG folders, database, config and service registration, the developer's `OPENCODE_*`, `OTEL_*`
and `SENTRY_*` environment removed), so it never touches the developer's app, profile or live service.

| Case                            | Launch                                                                              | Ends on      |
| ------------------------------- | ----------------------------------------------------------------------------------- | ------------ |
| launch to Home                  | Profile kept from earlier launches; the service already runs, from the bundled CLI. | Home         |
| launch to a restored tab        | Profile kept; the first launch's onboarding draft is restored.                      | The composer |
| launch to Home, service stopped | Profile kept; the desktop spawns its service.                                       | Home         |
| first launch                    | No profile or GPU shader caches: right after an install, onboarding opens a draft.  | The composer |
| dev start to Home               | `bun dev:desktop` with Vite's caches and `out` deleted.                             | Home         |

```bash
# A returning user's launches of two packaged builds (pack each with OPENCODE_CHANNEL=beta or prod), or two installed
# channels.
strobe bench perf/startup.bench.ts --target desktop --base exe:<old>/OpenCode.exe --head exe:<new>/OpenCode.exe
strobe bench perf/startup.bench.ts --target desktop --base app:opencode --head app:opencode-beta

# The first launch after an install.
strobe bench perf/startup.bench.ts --target install --base app:opencode --head app:opencode-beta

# The dev loop's cold start, dev against this checkout.
strobe bench perf/startup.bench.ts --target dev --base origin/dev --head .
```

strobe runs on Windows, macOS and Linux. Windows measures the most; on macOS a packaged launch needs a build whose bundle
id this account has never run (`packages/app/perf/README.md` lists what each OS gives).

Besides `launch.ready`, each launch reports its milestones as `launch.<name>` in ms since spawn: the main process's own
marks from its log (`entry`, `electron`, `window`, `served`, `bundle`, `logging`, `storage`, `init`, `layers`,
`visible`, `service.starting`, `service.ready`; `src/main/lifecycle/marks.ts`), or each step of the dev command's
output. `launch.painted` and `launch.settled` are when the window's pixels first and last changed, `cpu.work` is the CPU
every process used until ready, and `launch.node.*` is Node's bootstrap timing in builds that accept `--inspect`. The
first launch of each build is discarded, because a new binary pays the antivirus scan. The packaged
returning-user cases keep the GPU shader caches their build compiled in earlier launches, as a person's machine has
them; `first launch` starts each launch without them. `--why always` adds a profiled
launch per build: the main process and the renderer, both from their first statement.

A packaged beta or prod build registers itself as the `opencode://` handler when it starts, even from the bench; the
installed app takes the registration back on its next launch. Those channels run with `HTTPS_PROXY` pointed at a
closed port (`--offline` forces it for dev) so the updater's first check fails fast instead of reaching GitHub.
