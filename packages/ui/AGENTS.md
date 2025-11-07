# Repository Guidelines

## Project Structure & Module Organization

- Monorepo root is `/Users/guochunzhong/git/oss/opencode`; this package lives in `packages/ui`.
- Source lives in `src/`: `components/`, `hooks/`, `context/`, and `pierre/` for shared primitives.
- Styles and assets live in `src/styles/` (base + Tailwind entry) and `src/assets/` (fonts, audio, icons).
- Package scripts are under `script/`; configuration is in `tsconfig.json` and `vite.config.ts`.

## Build, Test, and Development Commands

- `bun install` (repo root): install workspace dependencies.
- `bun run dev` (packages/ui): run Vite for local UI development.
- `bun run typecheck` (packages/ui): run `tsgo --noEmit` for TypeScript checks.
- `bun run generate:tailwind` (packages/ui): regenerate Tailwind output for shared styles.
- `bun run typecheck` (repo root): run Turbo typechecks across all packages.

## Coding Style & Naming Conventions

- TypeScript ESM, two-space indentation, `printWidth: 100`, no semicolons; format with `bunx prettier --write`.
- Naming: camelCase for functions/locals, PascalCase for components/classes.
- Platform-specific files use `.client.ts` / `.server.ts`.
- Public entrypoints are defined in `package.json` `exports`; update it when adding new top-level modules or assets.

## Testing Guidelines

- The repo uses Bun’s `describe/test/expect`; tests generally live under each package’s `test/` folder.
- `packages/ui` currently has no dedicated test suite; add focused tests in a new `packages/ui/test` folder or in the consuming app when behavior is integration-specific.

## Commit & Pull Request Guidelines

- Commit subjects use a prefix like `chore:`, `tui:`, `release:`, `ignore:` plus an imperative summary; keep under ~72 chars and reference issues (e.g., `Refs #123`).
- PRs should explain the change, list verification steps (`bun run typecheck`, `bun run dev`), and include screenshots for UI-facing updates.

## Security & Configuration Tips

- Never commit `.env*` or secrets; configuration is read from environment variables (see `sst.config.ts`).
- Remove user-specific paths from fixtures or docs; prefer `.opencode/` in examples.
