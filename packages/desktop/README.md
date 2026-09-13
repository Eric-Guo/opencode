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
