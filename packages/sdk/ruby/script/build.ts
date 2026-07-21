#!/usr/bin/env bun

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

import { $ } from "bun"
import path from "path"

// Generate the V2 OpenAPI spec from the canonical Protocol definition.
await $`bun -e ${`
  import { OpenApi } from "effect/unstable/httpapi"
  import { ClientApi } from "@opencode-ai/protocol/client"

  const output = process.argv.at(-1)
  if (!output) throw new Error("Missing OpenAPI output path")
  await Bun.write(output, JSON.stringify(OpenApi.fromApi(ClientApi)))
`} ${path.join(dir, "openapi.json")}`.cwd(path.resolve(dir, "../../client"))

// Generate Ruby SDK using OpenAPI Generator CLI jar
const outputDir = "/Users/guochunzhong/git/oss/opencode_client_ruby"

// Clean previous generation
// await $`rm -rf ${outputDir}`

// Generate Ruby client with HTTPX
await $`openapi-generator-cli generate \
  -i ${dir}/openapi.json \
  -g ruby \
  -o ${outputDir} \
  -c ${dir}/config.json`

// Clean up OpenAPI spec
await $`rm openapi.json`

console.log("✅ Ruby SDK generated successfully!")
