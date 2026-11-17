import { expect, test } from "bun:test"
import { Schema } from "effect"
import { NexusBot } from "../src/nexus-bot.js"

test("Bot creation and duplication reserve the bot- prefix in Nexus's 32-character handle", () => {
  const decode = Schema.decodeUnknownSync(NexusBot.Command)

  for (const action of ["bot.create", "bot.duplicate"]) {
    expect(decode({ action, name: "a".repeat(28), description: "Bot", settings: {}, id: "existing" })).toMatchObject({
      name: "a".repeat(28),
    })

    for (const name of ["", "a".repeat(29), "Invalid", "has spaces"])
      expect(() => decode({ action, name, description: "Bot", settings: {}, id: "existing" })).toThrow()
  }
})
