# Repository Guidelines

## Project Structure & Module Organization

- Monorepo managed with Bun/Turbo. Core CLI lives in `packages/opencode`, Solid TUI console here in `packages/console`, marketing site in `packages/web`, shared UI in `packages/ui`, infra in `infra/`, specs in `specs/`, and SDKs in `sdks/`.
- Console app layout: `packages/console/app/` (SolidStart app), `core/` (data/business logic), `function/` (Cloudflare Workers), and `mail/` (email flows). Tests for the CLI sit under `packages/opencode/test/`.
- Keep integrations (`packages/plugin`, `packages/slack`, `packages/desktop`) self-contained while reusing primitives from shared packages.

## Build, Test, and Development Commands

- `bun install`: install workspace deps from `bun.lock`.
- `bun run dev`: proxies to `packages/opencode/src/index.ts` for fast CLI iterations.
- `bun run typecheck`: runs `bun turbo typecheck` across all workspaces.
- `cd packages/opencode && bun run build`: build CLI binaries via `script/build.ts`.
- `cd packages/opencode && bun run test`: Bun test runner for CLI suites.
- Debug console locally from `packages/opencode` with `bun dev` (CLI entry) or run SolidStart dev server from `packages/console` via your preferred workflow.

## Coding Style & Naming Conventions

- TypeScript ESM baseline; two-space indentation, `printWidth: 100`, no semicolons. Use `bunx prettier --write` before committing.
- Naming: camelCase for functions/locals, PascalCase for components/classes. Suffix platform-specific files with `.client.ts` / `.server.ts`.
- Export only intentional entrypoints through each package `exports` map.

## Testing Guidelines

- Tests use Bun’s `describe/test/expect`. Suites mirror features; CLI coverage in `packages/opencode/test/*` with fixtures under `fixture/`, `session/`, `snapshot/`.
- Every new command, adapter, or regression fix needs a targeted test plus fixture updates. Run `cd packages/opencode && bun run test` before pushing; add failing seed instructions when filing bugs.

## Commit & Pull Request Guidelines

- Commit messages usually start with prefixes like `chore:`, `tui:`, `release:`, `ignore:` followed by an imperative summary; keep subjects under ~72 chars and reference issues (e.g., `Refs #123`).
- PRs should outline the problem, list manual verification (`bun run typecheck`, scoped tests, build steps), and attach screenshots for console/web changes. Pair infra edits (`infra/`, `sst.config.ts`) with matching app changes.

## Security & Configuration Tips

- Never commit secrets or `.env*`; production config loads via environment variables consumed in `sst.config.ts`.
- Run binaries through `bin/opencode` or the install script to ensure `/patches` stay applied. Strip personal paths (prefer `.opencode/`) from fixtures and logs.
