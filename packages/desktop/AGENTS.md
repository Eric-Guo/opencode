# Repository Guidelines

## Project Structure & Module Organization
- `src/`: desktop-specific TypeScript/TSX entry points plus menu/updater/CLI glue.
- `src-tauri/`: Rust Tauri backend (`src-tauri/src`), config (`src-tauri/tauri*.json`), icons and bundled assets (`src-tauri/icons`, `src-tauri/resources`).
- `scripts/`: build helpers such as `prepare-resources.ts` and `predev.ts`.
- `dist/`, `ts-dist/`: generated build artifacts.

## Build, Test, and Development Commands
Run these from the repo root unless noted:
- `bun install`: install workspace dependencies.
- `bun run --cwd packages/desktop dev`: Vite web UI only.
- `bun run --cwd packages/desktop tauri dev`: web + native shell (http://localhost:1420).
- `bun run --cwd packages/desktop build`: prepare resources, typecheck, then Vite build.
- `bun run --cwd packages/desktop tauri build`: build the native bundle (invokes `build`).
- `bun run --cwd packages/desktop typecheck`: TypeScript typecheck.
- `bun run --cwd packages/desktop preview`: preview built web assets.

## Coding Style & Naming Conventions
- Keep to existing patterns: 2-space indentation, double quotes, and no semicolons in TS/TSX.
- Prefer immutable `const`, concise names, and small focused functions; avoid `else` where readability holds.
- Rust code follows standard `rustfmt` defaults (4-space indentation).
- Refer to the repo style guidance in `STYLE_GUIDE.md`.

## Testing Guidelines
- No dedicated test runner is configured in `packages/desktop`.
- Use `bun run --cwd packages/desktop typecheck` and manual QA via `dev`/`tauri dev`.
- If you add non-trivial logic, add a lightweight validation script and document it here.

## Commit & Pull Request Guidelines
- Commit history favors short, imperative summaries without strict prefixes; match that tone.
- Keep PRs small, link related issues, explain the fix, and avoid verbose LLM-style descriptions.
- For net-new features, open a design discussion issue before implementing.

## Monorepo Notes
- `bun dev` (repo root) runs OpenCode against `packages/opencode`.
- If API/SDK changes are made, regenerate the JS SDK via `./packages/sdk/js/script/build.ts`.
