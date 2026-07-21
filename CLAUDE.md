# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenCode is an AI-powered development tool built for the terminal. It's a 100% open-source, provider-agnostic AI coding agent with:

- Terminal user interface (TUI) built with SolidJS and OpenTUI
- Language Server Protocol (LSP) support
- Client/server architecture allowing remote control
- Support for Anthropic, OpenAI, Google, and local models
- Model Context Protocol (MCP) server integration

This is a monorepo using Bun workspaces and Turbo for builds. The codebase is primarily TypeScript with Cloudflare Workers for backend services.

## Common Development Commands

```bash
# Install all dependencies
bun install

# Start development server for the core CLI package
bun dev

# Run type checking across all packages
bun typecheck
# Or at root
bun turbo typecheck

# Build all packages
bun turbo build
# Or build single package
cd packages/cli && bun run build:bun --single

# Run all tests
bun test
# Run a specific test file
cd packages/core && bun test
```

### Package-Specific Development

```bash
# Core CLI and AI agent logic
cd packages/cli && bun dev

# Web console (SolidStart app)
cd packages/console/app && bun dev

# Desktop application
cd packages/desktop && bun dev

# Documentation site (Astro)
cd packages/web && bun dev
```

## High-Level Architecture

### Monorepo Structure

- **packages/core**: Core AI agent, tools, configuration, and session logic
- **packages/cli**: CLI commands and process entrypoints
- **packages/server**: HTTP API implementation
- **packages/protocol**: Public API definitions
- **packages/tui**: Terminal UI code (SolidJS with OpenTUI)

- **packages/console**: Web-based console for managing projects
  - `app/`: SolidStart application
  - `core/`: Database and business logic
  - `function/`: Cloudflare Workers backend
  - `mail/`: Email functionality

- **packages/desktop**: Desktop application wrapper
- **packages/web**: Astro-based documentation site
- **packages/plugin**: Plugin system and `@opencode-ai/plugin` package
- **packages/ui**: Shared UI components
- **packages/script**: Build scripts and utilities
- **packages/slack**: Slack integration

- **infra**: SST infrastructure-as-code for Cloudflare deployment
- **sdks**: SDK packages (JavaScript/TypeScript, Go, Python)

### Client/Server Architecture

The terminal UI can run locally while being controlled remotely. The Go TUI communicates with the TypeScript server via a Stainless SDK. This allows the TUI frontend to be one of many possible clients.

### Infrastructure

- **Runtime**: Bun (primary), Node.js
- **Frontend**: SolidJS with OpenTUI for terminal UI
- **Backend**: Cloudflare Workers with Hono framework
- **Database**: PlanetScale (MySQL-compatible)
- **Auth**: OpenAuth.js
- **Deployment**: SST to Cloudflare (configured in `sst.config.ts`)

## Code Style and Conventions

### General Principles

- Keep logic in single functions unless composition is needed
- Avoid unnecessary destructuring
- Avoid `else` statements
- Prefer `.catch()` over `try`/`catch` when possible
- Use precise types, avoid `any`
- Prefer immutable patterns, avoid `let`
- Use concise single-word identifiers when descriptive
- Leverage Bun APIs like `Bun.file()`

### Error Handling

- Use `Result` patterns and avoid throwing exceptions in tools
- When modifying the public Protocol or Server `HttpApi`, regenerate the client from `packages/client`

### Validation

- Use Zod for runtime validation of inputs
- Follow existing patterns in the codebase

### Testing

- Unit tests live in the V2 package that owns the implementation
- Test files follow the pattern `*.test.ts`
- Run tests with `bun test` from package directories
- Key test areas: snapshot testing, utilities, configuration, file operations

## Key Configuration Files

- **package.json**: Root package with workspace setup, catalog dependencies
- **turbo.json**: Build pipeline configuration
- **sst.config.ts**: Infrastructure as code for Cloudflare deployment
- **tsconfig.json**: TypeScript configuration extending `@tsconfig/bun`
- **.opencode/opencode.json**: OpenCode-specific configuration with MCP servers and plugins

## Important Development Notes

### SDK Regeneration

After changing the public Protocol or Server `HttpApi`, run:

```bash
cd packages/client && bun run generate
```

This regenerates the JavaScript SDK for client-server communication.

### MCP Integration

The project supports Model Context Protocol (MCP) servers configured in `.opencode/opencode.json`:

- Local MCP servers (e.g., weather server)
- Remote MCP servers (e.g., Context7)

## Available CLI Commands

The OpenCode V2 CLI commands are defined under `packages/cli/src/commands`:

- `acp`: Agent Control Protocol
- `mcp`: Model Context Protocol management
- `tui thread/spawn/attach`: TUI-related operations
- `run`: Run a task
- `generate`: Generate code
- `debug`: Debug mode
- `auth`: Authentication
- `agent`: Agent management
- `upgrade`: Upgrade OpenCode
- `serve`: Start server
- `web`: Web interface
- `models`: Manage models
- `stats`: Show statistics
- `export/import`: Data operations
- `github`: GitHub integration

## AI Integration

- Provider-agnostic support (Anthropic, OpenAI, Google, local models)
- Session management with compaction and summarization
- Plugin system for extensibility
- Real-time state synchronization
- Durable objects for Cloudflare Workers

## Commit Style

Follow [Conventional Commits](https://www.conventionalcommits.org/) specification. The project uses Husky for pre-commit hooks and Prettier for code formatting.
