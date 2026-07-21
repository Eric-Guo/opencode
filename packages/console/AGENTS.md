# Repository Guidelines

## Project Structure & Module Organization

- Monorepo managed with Bun/Turbo. V2 runtime code lives in `packages/core`, `packages/cli`, and `packages/server`; Solid TUI console code lives here in `packages/console`, with shared UI in `packages/ui`.
- Console app layout: `packages/console/app/` (SolidStart app), `core/` (data/business logic), `function/` (Cloudflare Workers), and `mail/` (email flows). Runtime tests live in their owning V2 packages.
- Keep integrations (`packages/plugin`, `packages/slack`, `packages/desktop`) self-contained while reusing primitives from shared packages.

## Build, Test, and Development Commands

- `bun install`: install workspace deps from `bun.lock`.
- `cd packages/cli && bun dev`: runs the V2 CLI entrypoint.
- `bun run typecheck`: runs `bun turbo typecheck` across all workspaces.
- `cd packages/cli && bun run build:bun --single`: build the current-platform V2 CLI binary.
- Run tests from the owning package, such as `cd packages/core && bun run test`.
- Debug the CLI locally from `packages/cli` with `bun dev`, or run the SolidStart dev server from `packages/console`.

## Coding Style & Naming Conventions

- TypeScript ESM baseline; two-space indentation, `printWidth: 100`, no semicolons. Use `bunx prettier --write` before committing.
- Naming: camelCase for functions/locals, PascalCase for components/classes. Suffix platform-specific files with `.client.ts` / `.server.ts`.
- Export only intentional entrypoints through each package `exports` map.

## Testing Guidelines

- Tests use Bun’s `describe/test/expect`. Suites and fixtures live in the V2 package that owns the feature.
- Every new command, adapter, or regression fix needs a targeted test plus fixture updates. Run the owning package's test command before pushing.

## Commit & Pull Request Guidelines

- Commit messages usually start with prefixes like `chore:`, `tui:`, `release:`, `ignore:` followed by an imperative summary; keep subjects under ~72 chars and reference issues (e.g., `Refs #123`).
- PRs should outline the problem, list manual verification (`bun run typecheck`, scoped tests, build steps), and attach screenshots for console/web changes. Pair infra edits (`infra/`, `sst.config.ts`) with matching app changes.

## Security & Configuration Tips

- Never commit secrets or `.env*`; production config loads via environment variables consumed in `sst.config.ts`.
- Run binaries through `bin/opencode` or the install script to ensure `/patches` stay applied. Strip personal paths (prefer `.opencode/`) from fixtures and logs.
