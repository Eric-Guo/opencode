import { $ } from "bun"

const mode = process.argv[2]
if (mode !== "dev" && mode !== "prod") throw new Error("Usage: copy-icons.ts <dev|prod>")

const src = `../desktop/src-tauri/icons/${mode}`
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied ${mode} icons from ${src} to ${dest}`)
