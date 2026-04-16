# OpenCode Monorepo Agent Guide

This file is for coding agents working in `/Users/ryanvogel/dev/opencode`.

## Scope And Precedence

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

- Prefer early returns over nested `else` blocks.
- Keep functions focused; split only when it improves reuse or readability.

### Error Handling

- Fail with actionable messages.
- Avoid swallowing errors silently.
- Log enough context to debug production issues (IDs, env, status), but never secrets.
- In UI code, degrade gracefully for missing capabilities.

### Data / DB

- For Drizzle schema, use snake_case fields and columns.
- Keep migration and schema changes minimal and explicit.
- Follow package-specific DB guidance in `packages/opencode/AGENTS.md`.

### Testing Philosophy

- Prefer testing real behavior over mocks.
- Add regression tests for bug fixes where practical.
- Keep fixtures small and focused.

## Agent Workflow Tips

- Read existing code paths before introducing new abstractions.
- Match local patterns first; do not impose a new style per file.
- If a package has its own `AGENTS.md`, review it before editing.
- For OpenCode Effect services, follow `packages/opencode/AGENTS.md` strictly.

## Known Operational Notes

- `packages/app/AGENTS.md` says: never restart app/server processes during that package's debugging workflow.
- `packages/app/AGENTS.md` also documents local backend+web split for UI work.
- `packages/opencode/AGENTS.md` contains mandatory Effect and database conventions.

## Regeneration / Special Scripts

- Regenerate JS SDK with: `./packages/sdk/js/script/build.ts`

## Quick Checklist Before Finishing

- Ran relevant package checks.
- Updated docs/config when behavior changed.
- Avoided committing unrelated files.
- Kept edits minimal and aligned with local conventions.
