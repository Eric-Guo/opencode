# Console local database (no Docker)

This console talks to MySQL through the PlanetScale Data API (`@planetscale/database` + Drizzle). There is no local MySQL server or Docker image to run; instead, create a personal PlanetScale branch and point the app to it via `SST_RESOURCE_*` environment variables.

## Prerequisites
- PlanetScale CLI: `brew install planetscale/tap/pscale` (or grab from https://github.com/planetscale/cli/releases)
- Bun installed and `bun install` has been run at the repo root
- Access to the PlanetScale org that owns the `opencode` database (or permission to create your own DB)

## Create a dev branch and password
1. Authenticate: `pscale auth login`
2. Create a database for local work (skip if you already have one): `pscale database create opencode-local`
3. Create an isolated branch: `pscale branch create opencode-local local`
4. Generate credentials for that branch:
   - `pscale password create opencode-local local console-local`
   - Capture the **Access Host URL**, **Username**, and **Password** from the output. The host value is what the Data API client expects.

## Wire credentials into the app
Set the SST resource env vars so both the console server and Drizzle see the same connection info. You can drop this in `packages/console/.env.local` and `source` it before running commands:

```bash
# identifies the stage for feature flags in code
export SST_RESOURCE_App='{"name":"opencode","stage":"local"}'

# Planetscale connection used by @planetscale/database and drizzle-kit
export SST_RESOURCE_Database='{
  "type":"sst.sst.Linkable",
  "host":"<access-host-url>",
  "database":"opencode-local",
  "username":"<username>",
  "password":"<password>",
  "port":3306
}'
```

Note: `host` should be the **Access Host URL** value (e.g. `aws.connect.psdb.cloud`), not a MySQL proxy port.

## Can I use local Percona/MySQL instead?
- Not out of the box. The console uses the PlanetScale Data API driver (`@planetscale/database` + `drizzle-orm/planetscale-serverless`), which speaks HTTPS—not the MySQL wire protocol that Percona exposes. Pointing it at `127.0.0.1:3306` will fail.
- If you must use Percona locally, you would need to swap the driver to `mysql2` (e.g., `drizzle-orm/mysql2`) in `core/src/drizzle/index.ts` and adjust `core/drizzle.config.ts`/migrations accordingly. That change is not currently implemented or tested in this repo.
- Easiest path today: use a small PlanetScale branch as described above. You can create creds via their UI if you want to avoid installing the CLI.

## Apply migrations
With the env vars loaded:

```bash
cd packages/console/core
bunx drizzle-kit push --config ./drizzle.config.ts
```

This runs the SQL in `core/migrations` against your branch. Re-run after schema changes to keep the database in sync.

## Verify
- Optional: `bunx drizzle-kit studio --config ./drizzle.config.ts` to inspect tables.
- Start the console dev server (from `packages/console/app`) with the same env vars in scope: `bun dev`.
