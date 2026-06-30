# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

The desktop prebuild prepares the embedded server sidecar and desktop assets. Optional renderer bundles such as 7777 are built by their distribution extension.

See [EXTENSIONS.md](./EXTENSIONS.md) for the optional desktop extension API. The SigmaAgents tab shell is maintained in the separate `packages/desktop-tab` checkout; build it with `OPENCODE_DESKTOP_EXTENSION=../desktop-tab bun run build`.
Production builds use the same flow:

```bash
OPENCODE_CHANNEL=prod bun run build
OPENCODE_CHANNEL=prod bun run package
```

Set `RUST_TARGET` when building the sidecar for a different architecture, and pass the matching platform and architecture
flags to `electron-builder` when packaging. The sidecar and its assets are included under `out/main` in the app archive.
A separate CLI distribution is not required.

`bun dev` builds the embedded sidecar from source and starts the development renderer with the dev app identity.
