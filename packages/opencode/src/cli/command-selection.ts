const commands = new Set([
  "acp",
  "mcp",
  "run",
  "generate",
  "debug",
  "console",
  "providers",
  "auth",
  "agent",
  "upgrade",
  "uninstall",
  "serve",
  "web",
  "models",
  "stats",
  "export",
  "import",
  "github",
  "pr",
  "session",
  "plugin",
  "plug",
  "db",
  "completion",
])

export function selectCommandSet(args: string[]) {
  if (args.includes("__v2-serve")) return "server"
  if (!args.some((arg) => commands.has(arg)) && !args.some((arg) => ["-h", "--help"].includes(arg))) return "tui"
  return "all"
}
