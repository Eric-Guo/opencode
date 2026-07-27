import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Model } from "@opencode-ai/core/model"
import { CybrosTrace } from "@opencode-ai/core/plugin/cybros"
import { Project } from "@opencode-ai/core/project"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Money } from "@opencode-ai/schema/money"

test("builds the Cybros session and assistant usage trace", () => {
  const created = DateTime.makeUnsafe(1_000)
  const agent = Agent.ID.make("build")
  const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
  const trace = CybrosTrace.build(
    Session.Info.make({
      id: Session.ID.make("ses_cybros"),
      projectID: Project.ID.global,
      title: "Trace",
      cost: Money.USD.make(0),
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      location: { directory: AbsolutePath.make("/workspace") },
      time: { created, updated: created },
    }),
    [
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_cybros"),
        type: "assistant",
        agent,
        model,
        content: [],
        cost: Money.USD.make(0.25),
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        time: { created, completed: created },
      }),
    ],
  )

  expect(trace).toEqual({
    session: {
      id: Session.ID.make("ses_cybros"),
      directory: AbsolutePath.make("/workspace"),
      title: "Trace",
      version: InstallationVersion,
      time_created: 1_000,
    },
    messages: [
      {
        msgID: SessionMessage.ID.make("msg_cybros"),
        modelID: Model.ID.make("model"),
        providerID: Provider.ID.make("provider"),
        mode: Agent.ID.make("build"),
        agent: Agent.ID.make("build"),
        cost: Money.USD.make(0.25),
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      },
    ],
  })
})
