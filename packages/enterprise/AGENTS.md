# Repository Guidelines

## Project Structure & Module Organization

- `src/` holds SolidStart app code. Key areas: `src/routes/` for route files, `src/core/` for shared domain logic, and `src/entry-*.tsx` for server/client entrypoints.
- `test/` contains Bun tests, currently under `test/core/` with `*.test.ts` files.
- `public/` stores static assets served by Vite.
- Root config lives in `vite.config.ts` and `tsconfig.json`.

## Build, Test, and Development Commands

- `bun install`: install workspace dependencies (requires Node >=22).
- `bun run dev`: start the local Vite dev server for the SolidStart app.
- `bun run build`: create a production build.
- `bun run build:cloudflare`: build with the Cloudflare preset (`OPENCODE_DEPLOYMENT_TARGET=cloudflare`).
- `bun run start`: run the production server from the built output.
- `bun run typecheck`: run TypeScript checks via `tsgo --noEmit`.
- `bun test` or `bun test test/core`: run Bun tests.

## Coding Style & Naming Conventions

- TypeScript ESM; JSX uses `solid-js` (`jsxImportSource` set in `tsconfig.json`).
- Two-space indentation, 100-char line width, and no semicolons (use Prettier: `bunx prettier --write`).
- Naming: camelCase for functions/locals, PascalCase for Solid components.
- Use `~/` path aliases for `src/` imports (e.g., `~/core/storage`).

## Testing Guidelines

- Tests use `bun:test` (`describe/test/expect`).
- Place tests under `test/` and name them `*.test.ts` (e.g., `test/core/share.test.ts`).
- Clean up any persisted test data (see `afterAll` in `test/core/storage.test.ts`).

## Commit & Pull Request Guidelines

- Commit subject format: prefix + imperative summary (e.g., `chore: update share sync`), keep under ~72 chars.
- Reference issues when relevant (e.g., `Refs #123`).
- PRs should include a clear problem/solution description, manual verification steps, and screenshots for UI changes.

## Security & Configuration Tips

- Do not commit `.env*`, credentials, or generated logs.
- Deployment toggles use environment variables like `OPENCODE_DEPLOYMENT_TARGET` and `OPENCODE_BASE_URL`.
