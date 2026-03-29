const { run } = require("@tauri-apps/cli")

const args = process.argv.slice(2)
console.log("Running tauri with args:", args)

run(args).catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
