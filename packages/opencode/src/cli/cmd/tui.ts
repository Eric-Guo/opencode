import { cmd } from "./cmd"
import { v2ServerCommand } from "./v2-server-command"

export const TuiCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    yargs
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      }),
  handler: async (args) => {
    const { runV1TuiBridge } = await import("@opencode-ai/cli/tui")
    await runV1TuiBridge({
      directory: args.project,
      continue: args.continue,
      session: args.session,
      standaloneCommand: v2ServerCommand(),
    })
  },
})
