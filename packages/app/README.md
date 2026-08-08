## Usage

Dependencies for these templates are managed with [pnpm](https://pnpm.io) using `pnpm up -Lri`.

This is the reason you see a `pnpm-lock.yaml`. That said, any package manager will work. This file can safely be removed once you clone a template.

```bash
$ npm install # or pnpm install or yarn install
```

### Learn more on the [Solid Website](https://solidjs.com) and come chat with us on our [Discord](https://discord.com/invite/solidjs)

## Available Scripts

In the project directory, you can run:

### `npm run dev` or `npm start`

Runs the app in the development mode.<br>
Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

The page will reload if you make edits.<br>

### Connecting to a password-protected local server

The app connects to the opencode server at `http://localhost:4096` by default. Keep the Vite dev server running while using the app:

```bash
bun run dev
```

`OPENCODE_SERVER_PASSWORD` protects the backend, but Vite does not automatically forward it to browser requests. If the backend was started with a password, export the same password in the shell that opens the app and pass it as an encoded startup token:

```bash
export PLAYWRIGHT_SERVER_HOST=4096
export OPENCODE_SERVER_PASSWORD="..."
AUTH_TOKEN="$(bun -e 'process.stdout.write(encodeURIComponent(btoa(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`)))')" open "http://localhost:3000/?auth_token=$AUTH_TOKEN"
```

For a persistent connection, open **Settings → Servers**, edit `http://localhost:4096`, and set the username to `opencode` and the password to the value of `OPENCODE_SERVER_PASSWORD`.

To distinguish an authentication problem from a server startup problem, check the authenticated health endpoint. A successful response returns HTTP `200`; the same request without credentials returns HTTP `401` when password protection is enabled.

```bash
curl --user "opencode:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:4096/api/health
```

### `npm run build`

Builds the app for production to the `dist` folder.<br>
It correctly bundles Solid in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.<br>
Your app is ready to be deployed!

## E2E Testing

Playwright starts the Vite dev server automatically via `webServer`, and UI tests expect an opencode backend at `localhost:4096` by default.

```bash
bunx playwright install chromium
bun run test:e2e:local
bun run test:e2e:local -- --grep "settings"
```

Environment options:

- `PLAYWRIGHT_SERVER_HOST` / `PLAYWRIGHT_SERVER_PORT` (backend address, default: `localhost:4096`)
- `PLAYWRIGHT_PORT` (Vite dev server port, default: `3000`)
- `PLAYWRIGHT_BASE_URL` (override base URL, default: `http://localhost:<PLAYWRIGHT_PORT>`)

## Deployment

You can deploy the `dist` folder to any static host provider (netlify, surge, now, etc.)
