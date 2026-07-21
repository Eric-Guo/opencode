# CODEBUDDY.md This file provides guidance to CodeBuddy Code when working with code in this repository.

## Project Overview

OpenCode is an AI-powered development tool built for the terminal. It's an open-source, provider-agnostic AI coding agent with a focus on a terminal user interface (TUI), LSP integration, and a client/server architecture. The project is a monorepo managed with Bun workspaces and Turbo.

## Development Commands

**Installation:**

```bash
# Install all dependencies
bun install
```

**Core Development:**

```bash
# Start development server for the core CLI package
bun dev

# To run the V2 CLI from `packages/cli`, use `bun dev`

# Run type checking across all packages
bun typecheck

# Build all packages
bun turbo build

# Run all tests
bun test

# Run a single test file
cd packages/core && bun test
```

**Package-Specific Development:**

- **Core CLI**: `cd packages/cli && bun dev`
- **Web Console**: `cd packages/console/app && bun dev`
- **Desktop App**: `cd packages/desktop && bun dev`
- **Documentation**: `cd packages/web && bun dev`

## High-Level Architecture

The OpenCode project is a monorepo with the following key packages:

- `packages/core`: Core AI agent and session logic.
- `packages/cli`: The command-line entrypoint and TUI launcher.
- `packages/server`: The HTTP server.
- `packages/console`: The web-based console for managing projects, which includes:
  - `app`: The main SolidStart console application.
  - `core`: Database and business logic.
  - `function`: Cloudflare Workers for backend services.
- `packages/desktop`: The desktop application wrapper.
- `packages/web`: The Astro-based documentation site.
- `sdks`: SDKs for JavaScript/TypeScript, Go, and Python.

**Client/Server Architecture:**
The terminal UI can run locally while being controlled remotely. After changing the public Protocol or Server `HttpApi`, regenerate the client from `packages/client` with `bun run generate`.

## Code Style and Conventions

- **Runtime**: The project primarily uses Bun and TypeScript.
- **Error Handling**: Use `Result` patterns and avoid throwing exceptions in tools.
- **Validation**: Use Zod for runtime validation of inputs.
- **Dependency Injection**: Use the `App.provide()` pattern for dependency injection.
- **API Client**: After modifying public endpoints in `packages/protocol` or `packages/server`, run `bun run generate` from `packages/client`.
- **General Principles**:
  - Keep logic in single functions unless composition is needed.
  - Avoid unnecessary destructuring.
  - Avoid `else` statements and `try`/`catch` where possible.
  - Use precise types and avoid `any`.
  - Prefer immutable patterns and avoid `let`.
