# OpenCode

OpenCode is an AI-powered development tool that runs in the terminal. It is a 100% open-source, provider-agnostic, client-server AI coding agent.

## Project Overview

This is a monorepo containing the OpenCode project. It is built with TypeScript and uses Bun as the package manager. The project is deployed to Cloudflare using [SST](https://sst.dev/).

The monorepo is structured as follows:

- `packages/opencode`: The core CLI application.
- `packages/function`: The serverless API, deployed as a Cloudflare Worker.
- `packages/web`: The documentation website, built with Astro.
- `packages/console`: The web-based console, built with SolidStart.
- `packages/desktop`: The desktop application, deployed as a static site.
- `packages/sdk`: The OpenCode SDK.
- `packages/slack`: A Slack bot.
- `infra`: The SST infrastructure-as-code definitions.

## Building and Running

### Prerequisites

- [Bun](https://bun.sh/)
- [Node.js](https://nodejs.org/)

### Running the CLI

To run the OpenCode CLI in development mode, use the following command:

```bash
bun run dev
```

### Typechecking

To typecheck the entire project, run:

```bash
bun turbo typecheck
```

## Development Conventions

- The project uses [Prettier](https://prettier.io/) for code formatting.
- The project uses [Husky](https://typicode.github.io/husky/) for pre-commit hooks.
- Commits should follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.
