# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

The host defaults to the base desktop. To start the SigmaAgents tab shell, run this from `packages/desktop`:

```bash
OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run dev
```

Alternatively, run `bun run dev` from `packages/desktop-tab`; its script selects the extension automatically. Development rebuilds from source, so a previous extension-enabled build does not select the extension for a later `dev` command. An environment variable prefixed to one command applies only to that command.

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

The desktop prebuild prepares the embedded server sidecar and desktop assets. Optional renderer bundles such as 7777 are built by their distribution extension.

See [EXTENSIONS.md](./EXTENSIONS.md) for the optional desktop extension API and the separate `packages/desktop-tab` checkout's [README](../desktop-tab/README.md) for renderer prerequisites. To build and package the SigmaAgents tab shell for macOS, run these commands from `packages/desktop`, keeping the extension setting on both commands:

```bash
OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run build
OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run package:mac
```

Use the same prefix with `package`, `package:win`, or `package:linux`. Packaging consumes the current `out` directory, so build with the extension selected before packaging; setting the variable only on the packaging command does not rebuild a base desktop bundle into the tab version.

For production tab builds, also set `OPENCODE_CHANNEL=prod` on both commands:

```bash
OPENCODE_CHANNEL=prod OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run build
OPENCODE_CHANNEL=prod OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run package
```

Set `RUST_TARGET` when building the sidecar for a different architecture, and pass the matching platform and architecture
flags to `electron-builder` when packaging. The sidecar and its assets are included under `out/main` in the app archive.
A separate CLI distribution is not required.

`bun dev` builds the embedded sidecar from source and starts the development renderer with the dev app identity.

## Startup benchmark

`bun run bench:startup` measures a **packaged** build from process spawn to the restored tab being ready and the
renderer going idle, so dev-server and bundling costs are not part of the numbers.

```bash
OPENCODE_CHANNEL=dev bun run build && bunx electron-builder --win --dir --config electron-builder.config.ts
bun run bench:startup -- --runs 5                                  # warm service (started once, reused by every launch)
bun run bench:startup -- --runs 5 --compare dist/other/OpenCode\ Dev.exe   # A/B: alternate launches of two builds
bun run bench:startup -- --service cold                            # each launch spawns the service
bun run bench:startup -- --fresh                                   # first launch after an install (profile wiped each time)
bun run bench:startup -- --profile-main --profile-renderer --trace # CPU profiles and a Chromium startup trace
bun run bench:startup -- --seed "%APPDATA%\ai.opencode.desktop.dev"   # restore tabs and drafts from an existing profile
```

The app runs in an isolated home (`%TEMP%\opencode-bench-startup`): its own `%APPDATA%`, XDG directories, OpenCode
database, config and service registration, with the developer's `OPENCODE_*` and `OTEL_*` environment stripped
(an inherited OTLP endpoint alone adds a network round trip to every CLI exit). It never attaches to or restarts the
developer's live service, and only ever kills the process tree it spawned. `--service cold` stops the service before
each launch so the desktop has to spawn it; the isolated config directory gives that service a private port. One
`--warmup` launch per build is discarded by default because the first launch of a new binary pays the antivirus scan.
`--compare` alternates two builds so machine drift affects both equally; they must bundle the same CLI or the desktop
restarts the service on the version mismatch.

Milestones (ms since spawn) come from the main log, the renderer's performance timeline and DOM readiness polled over
CDP. Node's bootstrap timing is read from the main process after each run over `--inspect` (nothing attaches until the
run is over): `processCreated` → `nodeStart` is Electron's native init, `nodeStart` → `nodeBootstrapped` is Node
itself, and `nodeBootstrapped` → `appStarting` is Electron's JavaScript init plus our main bundle up to its first
log line. Renderer idle is the start of the first 500 ms window with under 10 % main-thread task time that stays quiet
for `--settle-ms`; `rendererTaskMs` is the renderer's total main-thread task time until then. Raw samples are
written to `dist/bench-startup`.

A packaged beta or prod build registers itself as the `opencode://` handler when it starts, even from the bench; the
installed app takes the registration back on its next launch. Those channels run with `HTTPS_PROXY` pointed at a
closed port (`--offline` forces it for dev) so the updater's first check fails fast instead of reaching GitHub.
