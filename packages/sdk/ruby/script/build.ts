#!/usr/bin/env bun

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

import { $ } from "bun"
import path from "path"

// Generate OpenAPI spec from opencode package
await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../opencode"))

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
