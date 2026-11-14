import { Schema } from "effect"
import {
  APIError,
  Conflict,
  NotFound,
  type AccessEntry,
  type Client,
  type RequestOptions,
  type Step,
} from "@cybros/agent"
import { approvalGrant } from "./approval-grant"
import { SkillOperation, skillOperation } from "./operation-skills"
import type { NexusApplication } from "./application"

const Conversation = { conversation: Schema.NonEmptyString, addressed: Schema.optional(Schema.Boolean) }
const Run = { run: Schema.NonEmptyString, addressed: Schema.optional(Schema.Boolean) }
const Page = { after: Schema.optional(Schema.String) }
const Turn = { ...Conversation, turn: Schema.NonEmptyString }
const Task = { ...Run, task: Schema.NonEmptyString }
const Key = { key: Schema.NonEmptyString }

export const Operation = Schema.Union([
  SkillOperation,
  Schema.Struct({ action: Schema.Literals(["identity", "rules"]) }),
  Schema.Struct({ action: Schema.Literal("followers"), side: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ action: Schema.Literal("adaptations"), model: Schema.optional(Schema.String) }),
  Schema.Struct({
    action: Schema.Literal("target"),
    host: Schema.NonEmptyString,
    addressed: Schema.optional(Schema.Boolean),
    host_type: Schema.optional(Schema.Literals(["conversation", "run"])),
  }),
  Schema.Struct({
    action: Schema.Literal("conversations"),
    ...Page,
    archived: Schema.optional(Schema.Boolean),
    side: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("runs"),
    ...Page,
    attention: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("providers") }),
  Schema.Struct({ action: Schema.Literal("models") }),
  Schema.Struct({
    action: Schema.Literal("open"),
    ...Key,
    title: Schema.optional(Schema.String),
    runner: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    restricted: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("upload"),
    name: Schema.NonEmptyString,
    mime: Schema.String,
    content: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("fetch"),
    upload: Schema.NonEmptyString,
    representation: Schema.optional(Schema.Literals(["thumbnail", "preview"])),
  }),
  Schema.Struct({ action: Schema.Literal("prompt.show"), slot: Schema.optional(Schema.String) }),
  Schema.Struct({
    action: Schema.Literal("call_tool"),
    ...Key,
    runner: Schema.NonEmptyString,
    tool: Schema.NonEmptyString,
    input: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  Schema.Struct({
    action: Schema.Literal("say"),
    ...Conversation,
    ...Key,
    text: Schema.String,
    model: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
    attachments: Schema.optional(Schema.Array(Schema.String)),
    instructions: Schema.optional(Schema.String),
    approval: Schema.optional(Schema.Literals(["bypass", "ask", "rules"])),
    deliver_at: Schema.optional(Schema.String),
    deliver_in: Schema.optional(Schema.String),
    answering_user_public_id: Schema.optional(Schema.String),
    reasoning_effort: Schema.optional(Schema.String),
    reasoning_enabled: Schema.optional(Schema.Boolean),
    side: Schema.optional(Schema.Boolean),
    tools: Schema.optional(Schema.Array(Schema.String)),
    executor_contexts: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.MutableJson))),
    until: Schema.optional(
      Schema.Struct({
        command: Schema.String,
        attempts: Schema.optional(Schema.Int),
        directory: Schema.optional(Schema.String),
      }),
    ),
    delivery: Schema.optional(Schema.Literals(["queue", "steer", "steer_now"])),
  }),
  Schema.Struct({
    action: Schema.Literals(["conversation", "attach", "stop", "archive", "unarchive", "delete", "inputs", "compact"]),
    ...Conversation,
  }),
  Schema.Struct({ action: Schema.Literal("result"), ...Conversation, input: Schema.optional(Schema.NonEmptyString) }),
  Schema.Struct({ action: Schema.Literal("events"), ...Conversation, ...Page }),
  Schema.Struct({
    action: Schema.Literal("side"),
    conversation: Schema.optional(Schema.NonEmptyString),
    ...Key,
    tools: Schema.optional(Schema.Literals(["read", "write"])),
  }),
  Schema.Struct({
    action: Schema.Literal("cost"),
    ...Conversation,
    amount: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    action: Schema.Literal("participants"),
    ...Conversation,
    principal: Schema.optional(Schema.String),
    level: Schema.optional(Schema.Literals(["full", "read", "none"])),
    remove: Schema.optional(Schema.Boolean),
    default: Schema.optional(Schema.Literals(["full", "read", "none"])),
  }),
  Schema.Struct({
    action: Schema.Literal("prompt.preview"),
    ...Conversation,
    prompt: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    answering_user_public_id: Schema.optional(Schema.String),
    variables: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
    template: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
  }),
  Schema.Struct({
    action: Schema.Literals(["history", "turns"]),
    ...Conversation,
    after_position: Schema.optional(Schema.Int),
    before_position: Schema.optional(Schema.Int),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  Schema.Struct({
    action: Schema.Literal("input.edit"),
    ...Conversation,
    input: Schema.NonEmptyString,
    version: Schema.Int,
    text: Schema.optional(Schema.String),
    delivery: Schema.optional(Schema.Literals(["queue", "steer", "steer_now"])),
    deliver_at: Schema.optional(Schema.String),
    deliver_in: Schema.optional(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("input.remove"), ...Conversation, input: Schema.NonEmptyString }),
  Schema.Struct({ action: Schema.Literal("input.reorder"), ...Conversation, inputs: Schema.Array(Schema.String) }),
  Schema.Struct({
    action: Schema.Literal("fork"),
    ...Conversation,
    ...Key,
    turn: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("rewind"),
    ...Turn,
    title: Schema.optional(Schema.String),
    ...Key,
    variant: Schema.optional(Schema.String),
    restore: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("regenerate"),
    ...Turn,
    ...Key,
    model: Schema.optional(Schema.String),
    restore: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ action: Schema.Literals(["turn", "variants", "turn.delete", "turn.request"]), ...Turn }),
  Schema.Struct({ action: Schema.Literal("turn.edit"), ...Turn, text: Schema.String }),
  Schema.Struct({
    action: Schema.Literals(["variant", "activate"]),
    ...Turn,
    variant: Schema.NonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("variant.visibility"),
    ...Turn,
    variant: Schema.NonEmptyString,
    concealed: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literals(["run", "run.result", "graph", "phases", "run.start", "run.resume", "run.delete"]),
    ...Run,
  }),
  Schema.Struct({
    action: Schema.Literals(["run.stop", "run.pause"]),
    ...Run,
    force: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("transcript"),
    ...Run,
    before: Schema.optional(Schema.String),
    prefix: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  Schema.Struct({
    action: Schema.Literals(["task", "abandon", "task.cancel", "task.compact", "request"]),
    ...Task,
  }),
  Schema.Struct({
    action: Schema.Literal("approve"),
    ...Task,
    always: Schema.optional(Schema.Boolean),
    match: Schema.optional(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("deny"), ...Task, reason: Schema.optional(Schema.String) }),
  Schema.Struct({
    action: Schema.Literal("retry"),
    ...Task,
    model: Schema.optional(Schema.String),
    reasoning_effort: Schema.optional(Schema.String),
    reasoning_enabled: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("run.say"),
    ...Run,
    ...Key,
    text: Schema.String,
    attachments: Schema.optional(Schema.Array(Schema.String)),
    delivery: Schema.optional(Schema.Literals(["queue", "steer", "steer_now"])),
  }),
  Schema.Struct({ action: Schema.Literal("run.inputs"), ...Run }),
  Schema.Struct({ action: Schema.Literal("run.input.remove"), ...Run, input: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("run.input.edit"),
    ...Run,
    input: Schema.String,
    version: Schema.Int,
    text: Schema.optional(Schema.String),
    delivery: Schema.optional(Schema.Literals(["queue", "steer", "steer_now"])),
  }),
  Schema.Struct({ action: Schema.Literal("run.events"), ...Run, ...Page }),
  Schema.Struct({
    action: Schema.Literal("append"),
    ...Run,
    ...Key,
    steps: Schema.mutable(Schema.Array(Schema.MutableJson)),
    expected_revision: Schema.optional(Schema.Int),
    resolve: Schema.optional(
      Schema.mutable(
        Schema.Array(
          Schema.Union([
            Schema.String,
            Schema.Struct({
              task: Schema.String,
              content: Schema.optional(Schema.MutableJson),
              outcome: Schema.optional(Schema.Literal("completed")),
            }),
          ]),
        ),
      ),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("answer"),
    ...Task,
    content: Schema.String,
    token: Schema.optional(Schema.String),
    outcome: Schema.optional(Schema.Literals(["completed", "failed"])),
  }),
  Schema.Struct({
    action: Schema.Literal("resolve"),
    ...Task,
    answer: Schema.Record(Schema.String, Schema.MutableJson),
  }),
])

/** Shared control operations. A run ID always addresses that exact run, including an old candidate. */
export class Operations {
  constructor(
    private readonly member: Client,
    private readonly application: NexusApplication,
    private readonly identity: { workspace: string; agent: string; runner: string },
  ) {}

  async command(value: unknown, options: RequestOptions = {}) {
    const input = Schema.decodeUnknownSync(Operation)(value)
    const workspace = this.member.workspace(this.identity.workspace)

    if (input.action === "identity") return this.identity
    if (input.action === "followers") {
      const conversations = await Promise.all(
        this.application.lifecycle
          .hostsSnapshot()
          .map(async (host) => ({
            host,
            info: await this.member.workspace(host.workspace).conversation(host.conversation).fetch(options),
          })),
      )
      return conversations
        .filter((row) => row.info.side === (input.side === true))
        .map((row) => ({
          host_type: "conversation",
          public_id: row.host.conversation,
          workspace: row.host.workspace,
          archived: !!row.info.archived_at,
          side: row.info.side,
          active_turn: row.info.active_turn_public_id,
        }))
    }
    if (input.action === "rules")
      return {
        grants: this.application.rules(),
        declared: (await this.member.profile.fetch(options)).configuration?.approval_rules ?? [],
      }
    if (input.action === "adaptations") {
      const prepared = await this.application.prepare()
      const model = input.model ?? prepared.model

      return {
        model,
        configuration: prepared.agent_configuration,
        facts: (await this.member.models.list(undefined, options)).find((row) => row.ref === model) ?? null,
      }
    }
    if (input.action === "target") {
      const conversation =
        input.host_type === "run"
          ? null
          : await workspace
              .conversation(input.host)
              .fetch(options)
              .catch((error: unknown) => {
                if (error instanceof APIError && error.status === 404 && input.host_type !== "conversation") return null
                throw error
              })
      if (conversation) {
        if (conversation.answering_user_public_id !== this.identity.agent && !input.addressed)
          throw new Error("This conversation belongs to another agent.")
        const turn =
          conversation.active_turn_public_id ??
          (await workspace.conversation(input.host).turns.list({ limit: 1 }, options)).items.at(-1)?.public_id
        const variant = turn
          ? (await workspace.conversation(input.host).turns.variants(turn, options)).items.find((row) => row.active)
          : undefined

        return {
          workspace: this.identity.workspace,
          conversation: input.host,
          turn: turn ?? null,
          variant: variant?.public_id ?? null,
          run: variant?.run_public_id ?? null,
          side: conversation.side,
        }
      }
      const run = await workspace.run(input.host).fetch(options)
      if (
        !input.addressed &&
        run.turn?.conversation_public_id &&
        (await workspace.conversation(run.turn.conversation_public_id).fetch(options)).answering_user_public_id !==
          this.identity.agent
      )
        throw new Error("This run belongs to another agent's conversation.")

      return {
        workspace: this.identity.workspace,
        conversation: run.turn?.conversation_public_id ?? null,
        turn: run.turn?.public_id ?? null,
        variant: null,
        run: input.host,
        side: false,
      }
    }
    if (input.action === "models") return this.member.models.list(undefined, options)
    if (input.action === "providers") return this.member.modelProviders.list(options)
    if (input.action === "open") return this.application.open(input, options)
    if (input.action === "upload")
      return this.member.uploads.create(
        new Blob([Buffer.from(input.content, "base64")], { type: input.mime }),
        input.name,
        options,
      )
    if (input.action === "fetch") {
      const file = await (input.representation === "thumbnail"
        ? this.member.uploads.thumbnail(input.upload, options)
        : input.representation === "preview"
          ? this.member.uploads.preview(input.upload, options)
          : this.member.uploads.bytes(input.upload, options))

      return {
        content: Buffer.from(await new Response(file.body).arrayBuffer()).toString("base64"),
        mime: file.contentType,
      }
    }
    if (input.action === "prompt.show")
      return input.slot
        ? this.member.profile.promptDocuments.read(input.slot, options)
        : this.member.profile.promptDocuments.list(options)
    if (
      input.action === "skills" ||
      input.action === "skill.show" ||
      input.action === "skill.remove" ||
      input.action === "skill.push"
    )
      return skillOperation(this.member, this.identity.workspace, input, options)
    if (input.action === "call_tool") {
      const rules = Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            tool: Schema.String,
            verdict: Schema.Literals(["allow", "ask", "deny"]),
            path: Schema.optional(Schema.String),
            match: Schema.optional(Schema.String),
            reason: Schema.optional(Schema.String),
            origin: Schema.optional(Schema.Literals(["model", "author", "kernel"])),
          }),
        ),
      )((await this.member.profile.fetch(options)).configuration?.approval_rules ?? [])
      const runner = (await this.application.runners.list()).runners.find((row) => row.public_id === input.runner)
      if (!runner) throw new Error("The selected runner is unavailable.")
      const created = await workspace.runs.create(
        {
          steps: [
            {
              tool: {
                name: input.tool,
                key: "call_tool",
                input: input.input ?? {},
                timeout_ms: input.timeout ?? 30000,
                route: { kind: "runner", runner_executor_public_id: input.runner },
                ...(runner.root
                  ? {
                      executor_context: {
                        "opencode.environment": { root: runner.root, directories: [], anchor: null },
                      },
                    }
                  : {}),
              },
            },
          ],
          approval_mode: "bypass",
          prompt_mechanism: "raw",
          default_runner_executor_public_id: input.runner,
          approval_rules: rules.map((rule) => ({ ...rule, origin: "author" as const })),
        },
        { ...options, idempotencyKey: input.key },
      )
      const run = workspace.run(created.run.public_id)
      await run.start(options).catch((error: unknown) => {
        if (!(error instanceof Conflict && error.code === "not_startable")) throw error
      })
      const info = await run.fetch(options)
      return run.waitForToolResult({ ...options, patienceMs: (input.timeout ?? 30000) + 5000 }).then(
        async (task) => {
          if (task.task.status !== "completed") await run.stop(true, { timeoutMs: 5000 })
          return { public_id: info.public_id, task }
        },
        async (error: unknown) => {
          await run.stop(true, { timeoutMs: 5000 }).catch(() => {})
          throw error
        },
      )
    }
    if (input.action === "conversations") {
      const query = { answering_user_public_id: this.identity.agent, after: input.after, side: input.side }

      return input.archived
        ? workspace.conversations.archived(query, options)
        : workspace.conversations.list(query, options)
    }
    if (input.action === "runs")
      return workspace.runs.list(
        {
          answering_user_public_id: this.identity.agent,
          attention: input.attention,
          after: input.after,
          status: input.status,
        },
        options,
      )

    if (input.action === "side")
      return this.application.openSide({ key: input.key, parent: input.conversation, tools: input.tools }, options)

    if ("conversation" in input) {
      const chat = workspace.conversation(input.conversation)
      const info = await chat.fetch(options)

      if (info.answering_user_public_id !== this.identity.agent && !input.addressed)
        throw new Error("This conversation belongs to another agent.")

      if (input.action === "attach") {
        this.application.lifecycle.adopt(this.identity.workspace, input.conversation)
        return info
      }
      if (input.action === "conversation")
        return { ...info, ingresses: await this.application.bindings(this.identity.workspace, input.conversation) }
      if (input.action === "say")
        return this.application.submit({ ...input, workspace: this.identity.workspace }, this.member, options)
      if (input.action === "result") {
        if (input.input) return chat.inputExecution(input.input).recover(options)

        const turn = info.active_turn_public_id ?? (await chat.turns.list({ limit: 1 }, options)).items[0]?.public_id
        if (!turn) return null
        const variant = (await chat.turns.variants(turn, options)).items.find((row) => row.active)
        if (!variant) return null

        return chat
          .execution({
            turn_public_id: turn,
            variant_public_id: variant.public_id,
            run_public_id: variant.run_public_id,
          })
          .recover(options)
      }
      if (input.action === "events") return chat.events({ after: input.after }, options)
      if (input.action === "cost")
        return input.amount === undefined
          ? info
          : chat.update({ lock_version: info.lock_version, cost_limit: input.amount }, options)
      if (input.action === "participants") {
        if (input.default === undefined && input.principal === undefined) return info.access

        const level = Schema.Literals(["full", "read", "none"])
        const entries: AccessEntry[] = info.access.entries
          .filter(
            (row) =>
              row.user_public_id !== input.principal &&
              row.handle !== input.principal &&
              "@" + row.handle !== input.principal,
          )
          .map((row) => ({ user_public_id: row.user_public_id, level: Schema.decodeUnknownSync(level)(row.level) }))
        if (input.principal && !input.remove) {
          if (!input.level) throw new Error("Provide a participant access level.")
          entries.push({
            ...(input.principal.startsWith("@")
              ? { handle: input.principal.slice(1) }
              : { user_public_id: input.principal }),
            level: input.level,
          })
        }

        return chat.setAccess(
          { default: input.default ?? Schema.decodeUnknownSync(level)(info.access.default), entries },
          options,
        )
      }
      if (input.action === "prompt.preview")
        return chat.estimateInput(
          {
            prompt: input.prompt,
            model: input.model ? { model: input.model } : undefined,
            answering_user_public_id: input.answering_user_public_id,
            variables: input.variables,
            template: input.template,
            render: true,
          },
          options,
        )
      if (input.action === "stop") return chat.cancel(options)
      if (input.action === "archive" || input.action === "delete") {
        const result = input.action === "archive" ? await chat.archive(options) : await chat.delete(options)

        await this.application.notify(input.action === "archive" ? "conversation.archived" : "conversation.ended", {
          workspace: this.identity.workspace,
          conversation: input.conversation,
        })
        if (input.action === "delete")
          await this.application.lifecycle.ended(this.identity.workspace, input.conversation)
        return result
      }
      if (input.action === "unarchive") return chat.unarchive(options)
      if (input.action === "compact") return chat.compact(undefined, options)
      if (input.action === "inputs") return chat.inputs.list(options)
      if (input.action === "input.remove") return chat.inputs.delete(input.input, options)
      if (input.action === "input.reorder") return chat.inputs.reorder([...input.inputs], options)
      if (input.action === "input.edit")
        return chat.inputs.update(
          input.input,
          {
            expected_lock_version: input.version,
            text: input.text,
            delivery_mode: input.delivery,
            deliver_at: input.deliver_at,
            deliver_in: input.deliver_in,
          },
          options,
        )
      if (input.action === "history")
        return chat.history(
          {
            after_position: input.after_position,
            before_position: input.before_position,
            limit: input.limit,
            include_execution: true,
          },
          options,
        )
      if (input.action === "turns")
        return chat.turns.list(
          { after_position: input.after_position, before_position: input.before_position, limit: input.limit },
          options,
        )
      if (input.action === "fork")
        return chat.fork(
          { turn_public_id: input.turn, variant_public_id: input.variant, title: input.title },
          { ...options, idempotencyKey: input.key },
        )
      if (input.action === "rewind")
        return chat.rewind(
          { turn_public_id: input.turn, variant_public_id: input.variant, title: input.title },
          { ...options, idempotencyKey: input.key, restoreCheckpoints: input.restore },
        )
      if (input.action === "regenerate") {
        const accepted = await chat.turns.regenerationReceipt(input.key, options).catch((error: unknown) => {
          if (error instanceof NotFound) return null

          throw error
        })
        const selection = input.model ? { model: { model: input.model } } : {}
        if (accepted)
          return {
            ...(await chat.turns.regenerate(input.turn, selection, { ...options, idempotencyKey: input.key })),
            restoration: { status: "unchanged", runners: [] },
          }

        const tail = (await chat.turns.list({ limit: 1 }, options)).items.at(-1)
        if (tail?.public_id !== input.turn)
          throw new Error("Regenerate requires the tail turn; rewind to an earlier turn first.")
        const variant = (await chat.turns.variants(input.turn, options)).items.find((row) => row.active)
        if (variant?.details_pruned_at) throw new Error("Execution details were pruned; start a new turn.")
        if (
          variant?.run_public_id &&
          !["completed", "canceled"].includes((await workspace.run(variant.run_public_id).fetch(options)).status)
        )
          throw new Error("This run is busy or needs attention; retry or stop it first.")

        const restoration =
          !variant?.runner_effects || variant.runner_effects.status === "untouched"
            ? { status: "untouched", runners: [] }
            : input.restore === false
              ? { status: "kept", runners: [] }
              : await chat.restoreCheckpoints(variant.runner_effects, {
                  ...options,
                  idempotencyKey: input.key + ":restore",
                })
        if (!["untouched", "kept", "restored"].includes(restoration.status))
          throw new Error("Checkpoint restoration prevented regeneration: " + JSON.stringify(restoration))

        return chat.turns.regenerate(input.turn, selection, { ...options, idempotencyKey: input.key }).then(
          (result) => ({ ...result, restoration }),
          (error: unknown) => {
            if (!(error instanceof APIError)) throw error
            return { turn_public_id: input.turn, restoration: { ...restoration, door_refused: error.message } }
          },
        )
      }
      if (input.action === "turn.request") {
        const variant = (await chat.turns.variants(input.turn, options)).items.find((row) => row.active)
        if (!variant) throw new Error("The turn has no active candidate.")
        return chat.turns.request(input.turn, variant.public_id, options)
      }
      if (input.action === "turn") return chat.turns.fetch(input.turn, undefined, options)
      if (input.action === "turn.delete") return chat.turns.delete(input.turn, options)
      if (input.action === "turn.edit") return chat.turns.edit(input.turn, { text: input.text }, options)
      if (input.action === "variants") return chat.turns.variants(input.turn, options)
      if (input.action === "variant") return chat.turns.variant(input.turn, input.variant, options)
      if (input.action === "activate") return chat.turns.activate(input.turn, input.variant, options)
      if (input.action === "variant.visibility")
        return chat.turns.setVariantViewState(input.turn, input.variant, { concealed: input.concealed }, options)
    }

    if ("run" in input) {
      const run = workspace.run(input.run)
      const info = await run.fetch(options)

      if (info.turn?.conversation_public_id && !input.addressed) {
        const chat = await workspace.conversation(info.turn.conversation_public_id).fetch(options)

        if (chat.answering_user_public_id !== this.identity.agent)
          throw new Error("This run belongs to another agent's conversation.")
      }

      if (input.action === "run.say")
        return run.inputs.create(
          {
            kind: "message",
            text: input.text,
            attachments: input.attachments ? [...input.attachments] : undefined,
            delivery_mode: input.delivery,
          },
          { ...options, idempotencyKey: input.key },
        )
      if (input.action === "run.inputs") return run.inputs.list(options)
      if (input.action === "run.input.remove") return run.inputs.delete(input.input, options)
      if (input.action === "run.input.edit")
        return run.inputs.update(
          input.input,
          { text: input.text, delivery_mode: input.delivery, expected_lock_version: input.version },
          options,
        )
      if (input.action === "run") return info
      if (input.action === "run.result")
        return {
          public_id: info.public_id,
          status: info.status,
          task_key: info.deliverable_task_key,
          output: info.deliverable_task_key ? (await run.task(info.deliverable_task_key).fetch(options)).output : null,
        }
      if (input.action === "run.events") return run.events({ after: input.after }, options)
      if (input.action === "append")
        return run.append(
          { steps: input.steps.map(operationStep), resolve: input.resolve, expected_revision: input.expected_revision },
          { ...options, idempotencyKey: input.key },
        )
      if (input.action === "graph") return run.graph(options)
      if (input.action === "phases") return run.phases(options)
      if (input.action === "run.start") return run.start(options)
      if (input.action === "run.resume") return run.resume(options)
      if (input.action === "run.stop") return run.stop(input.force, options)
      if (input.action === "run.pause") return run.pause(input.force, options)
      if (input.action === "run.delete") return run.delete(options)
      if (input.action === "transcript")
        return run.transcript({ before: input.before, prefix: input.prefix, limit: input.limit }, options)

      if ("task" in input) {
        const task = run.task(input.task)

        if (input.action === "task") return task.fetch(options)
        if (input.action === "approve") {
          const rule =
            input.always || input.match !== undefined
              ? approvalGrant(await task.fetch(options), input.match)
              : undefined
          const result = await task.approve(options)
          if (!rule) return result

          const grant = {
            rule,
            run: input.run,
            task: input.task,
            conversation: info.turn?.conversation_public_id ?? null,
            granted_at: new Date().toISOString(),
          }
          const failure = await this.application.grantRule(grant).then(
            () => undefined,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          )
          return { task: result, grant: failure ? { refused: failure } : grant }
        }
        if (input.action === "deny") return task.deny(input.reason, options)
        if (input.action === "retry")
          return task.retry(
            {
              model: input.model,
              reasoning_effort: input.reasoning_effort,
              reasoning_enabled: input.reasoning_enabled,
            },
            options,
          )
        if (input.action === "answer")
          return task.resolve(
            { content: input.content, resolution_token: input.token, outcome: input.outcome },
            options,
          )
        if (input.action === "resolve") return task.resolve({ answer: input.answer }, options)
        if (input.action === "abandon") return task.abandon(options)
        if (input.action === "task.cancel") return task.cancel(options)
        if (input.action === "task.compact") return task.compact(options)
        if (input.action === "request") return task.request(options)
      }
    }

    throw new Error("Unknown Nexus operation.")
  }
}

function operationStep(value: unknown): Step {
  if (Array.isArray(value)) return value.map(operationStep)

  const record = <F extends Schema.Struct.Fields>(fields: F) =>
    Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.MutableJson)])
  const step = Schema.decodeUnknownSync(
    Schema.Union([
      Schema.Struct({ tool: record({ name: Schema.NonEmptyString }) }),
      Schema.Struct({ model: record({ prompt: Schema.String }) }),
      Schema.Struct({ ask: record({ prompt: Schema.String }) }),
      Schema.Struct({ wait: record({ task: Schema.NonEmptyString }) }),
      record({ parallel: Schema.Array(Schema.MutableJson) }),
    ]),
  )(value)

  return "parallel" in step ? { ...step, parallel: step.parallel.map(operationStep) } : step
}
