import { readFile } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { setTimeout } from "node:timers/promises"
import { Schema } from "effect"
import {
  ThreadAccumulator,
  TranscriptAccumulator,
  type JsonObject,
  type JsonValue,
  type RunTranscript,
  type TurnPage,
  type TranscriptItem,
  type ProgressFrame,
} from "@cybros/agent"
import { modelRecoveryHint } from "../src/execution"
import { readSkill } from "../src/skills"

export type DevelopmentTerminal = {
  command(input: JsonObject): Promise<JsonValue>
  extension?(name: string, input: JsonObject): Promise<JsonValue>
  write(value: string | Uint8Array): void
  error(value: string): void
  signal: AbortSignal
  read?(): Promise<string>
  modes?(conversation: string, patch: { code_mode?: boolean }): Promise<void>
}

const strings = [
  "model",
  "dir",
  "runner",
  "agent",
  "instructions",
  "approval",
  "until",
  "attempts",
  "mode",
  "to",
  "in",
  "at",
  "attention",
  "host-type",
  "prefix",
  "scope",
  "token",
  "idempotency-key",
  "effort",
  "prompt",
  "template",
  "tools",
  "after",
  "limit",
  "match",
  "status",
  "outcome",
  "title",
  "before",
  "timeout",
  "mcp",
  "endpoint",
  "client",
] as const
const flags = [
  "restricted",
  "stream",
  "reasoning",
  "follow",
  "json",
  "thumbnail",
  "preview",
  "graceful",
  "always",
  "keep-checkpoints",
  "conceal",
  "restore",
  "now",
  "reasoning-enabled",
  "code-mode",
  "help",
  "side",
  "force",
  "conversation",
  "live",
  "raw",
  "clear",
  "read",
  "write",
] as const
const inputOptions = [
  "instructions",
  "approval",
  "until",
  "attempts",
  "at",
  "in",
  "now",
  "mode",
  "effort",
  "reasoning-enabled",
  "to",
] as const

export const developmentHelp = `Nexus development controls (source checkout only)
  do [TEXT]               open a conversation, optionally with text or attachments
  say HOST [TEXT]         submit or schedule another input (--mode steer|queue|steer_now)
  runs [--status STATUS] [--attention ATTENTION] [--after CURSOR]
  followers | providers | models | rules
  adaptations [--model PROVIDER/REFERENCE] [--json]
  attach HOST | watch HOST | follow HOST | result HOST
  transcript HOST [--before CURSOR] [--limit N] [--follow | --prefix KEY]
  graph HOST | phases HOST | task HOST KEY | request HOST KEY
  stop HOST [TASK] | pause HOST | resume HOST | retry HOST [TASK] | abandon HOST [TASK]
  approve HOST TASK [--always --match PREFIX] | deny HOST TASK [REASON] | answer HOST TASK TEXT
  compact CONVERSATION | compact RUN TASK | append HOST -f FILE | delete HOST
  inputs HOST | inputs rm HOST INPUT | inputs edit HOST INPUT [TEXT]
  turns CONVERSATION [--after POSITION] [--limit COUNT] [--json]
  variant CONVERSATION TURN [VARIANT --conceal|--restore] | activate CONVERSATION TURN VARIANT
  rewind CONVERSATION TURN | regenerate CONVERSATION TURN [--keep-checkpoints]
  side CONVERSATION [--tools read|write]
  fetch UPLOAD [--thumbnail|--preview] | call_tool RUNNER TOOL [INPUT_JSON]
  prompt show [SLOT] | prompt preview CONVERSATION [--prompt TEXT --var KEY=VALUE]
  skills | skills push DIRECTORY | skills show NAME | skills rm NAME [--scope agent|workspace]
  conversation participants CONVERSATION [add PRINCIPAL LEVEL|rm PRINCIPAL|default LEVEL]
  conversation cost CONVERSATION [AMOUNT|off]
  env [DIR --clear] | environment CONVERSATION [DIR] | environments
  port CONVERSATION --endpoint URL --token TOKEN [--read --write]
  runners [use RUNNER|none] | set_default_runner HOST RUNNER
  web.fetch URL | extension COMMAND [INPUT_JSON]
Options: --json --model MODEL --dir PATH --runner ID --attach FILE --instructions TEXT
         --until COMMAND --attempts N --approval ask|rules --idempotency-key KEY
`

export function parseDevelopment(args: readonly string[]) {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      ...(Object.fromEntries(strings.map((name) => [name, { type: "string" }])) as {
        [K in (typeof strings)[number]]: { type: "string" }
      }),
      ...(Object.fromEntries(flags.map((name) => [name, { type: "boolean" }])) as {
        [K in (typeof flags)[number]]: { type: "boolean" }
      }),
      attach: { type: "string", multiple: true },
      also: { type: "string", multiple: true },
      var: { type: "string", multiple: true },
      file: { type: "string", short: "f" },
    },
  })
  if (parsed.positionals[0] === "transcript" && parsed.values.follow && parsed.values.prefix !== undefined)
    throw new Error("--follow follows the mainline. Drop --prefix to follow this run.")
  const text = (key: (typeof strings)[number] | "file") => {
    const value = parsed.values[key]
    if (value === undefined) return undefined
    if (typeof value !== "string") throw new Error("--" + key + " requires text.")
    return value
  }
  const number = (key: (typeof strings)[number]) => {
    const value = text(key)
    if (value === undefined) return undefined
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error("--" + key + " requires a nonnegative integer.")
    return Number(value)
  }

  return {
    verb: parsed.positionals[0] ?? "help",
    args: parsed.positionals.slice(1),
    values: parsed.values,
    text,
    number,
  }
}

const Target = Schema.Struct({
  workspace: Schema.String,
  conversation: Schema.NullOr(Schema.String),
  run: Schema.NullOr(Schema.String),
  turn: Schema.optional(Schema.NullOr(Schema.String)),
  variant: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  side: Schema.Boolean,
})
const ObjectValue = Schema.Record(Schema.String, Schema.MutableJson)
const object = Schema.decodeUnknownSync(ObjectValue)

export async function runDevelopment(args: readonly string[], terminal: DevelopmentTerminal): Promise<number> {
  const parsed = parseDevelopment(args)
  const word = (index: number, label: string) => {
    const value = parsed.args[index]
    if (!value) throw new Error(parsed.verb + " requires " + label + ".")
    return value
  }
  const key = () => parsed.text("idempotency-key") ?? crypto.randomUUID()
  const call = (action: string, fields: Record<string, unknown> = {}) =>
    terminal.command(clean({ action, addressed: true, ...fields }))
  const print = (value: JsonValue) =>
    terminal.write(parsed.values.json ? JSON.stringify(value, null, 2) + "\n" : formatDevelopment(value))
  const target = async (id: string) =>
    Schema.decodeUnknownSync(Target)(
      await call("target", {
        host: id,
        host_type: parsed.values.conversation ? "conversation" : parsed.text("host-type"),
      }),
    )
  const conversation = async (id: string) => {
    const resolved = await target(id)
    if (!resolved.conversation) throw new Error("This run has no conversation.")
    return resolved.conversation
  }

  if (parsed.verb === "help" || parsed.values.help) {
    terminal.write(developmentHelp)
    return 0
  }
  if (parsed.verb === "runs") {
    const page = object(
      await call("runs", {
        attention: parsed.text("attention"),
        status: parsed.text("status"),
        after: parsed.text("after"),
      }),
    )
    if (parsed.values.json) {
      print(page)
      return 0
    }

    const items = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(page.items)
    if (!items.length) terminal.write("(this workspace holds no matching runs)\n")
    for (const row of items) {
      const reason = row.attention && object(row.attention).reason
      terminal.write(
        [
          row.public_id,
          row.status,
          reason && "ASKING: " + reason,
          row.followed ? "followed" : "not followed",
          row.failure_reason,
        ]
          .filter(Boolean)
          .join("  ") + "\n",
      )
    }
    if (page.next_after) terminal.write("Next cursor (pass with --after): " + page.next_after + "\n")
    return 0
  }
  if (parsed.verb === "adaptations") {
    const result = await call("adaptations", { model: parsed.text("model") })
    terminal.write(formatAdaptationInspection(result, parsed.values.json === true))
    return 0
  }
  if (parsed.verb === "followers") {
    const result = await call("followers", { side: parsed.values.side === true })
    if (parsed.values.json) print(result)
    else {
      const lists = object(result)
      const conversations = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(lists.conversations)
      const runs = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(lists.runs)
      const rows = [...conversations, ...runs]
      if (!rows.length) terminal.write("(this service is following no hosts)\n")
      for (const row of rows) {
        const until = row.until && object(row.until)
        const reason = row.attention && object(row.attention).reason
        terminal.write(
          [
            row.public_id ?? row.run ?? row.conversation,
            row.status,
            reason && "ASKING: " + reason,
            until && "until " + until.checks + "/" + until.attempts,
            row.parent && "side of " + row.parent,
            row.failure_reason,
          ]
            .filter(Boolean)
            .join("  ") + "\n",
        )
      }
    }
    return 0
  }
  if (parsed.verb === "providers") {
    const result = await call("providers")
    if (parsed.values.json) print(result)
    else {
      const rows = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(result)
      if (!rows.length) terminal.write("(this server serves no provider lanes)\n")
      for (const row of rows)
        terminal.write(
          [
            row.id,
            row.credentials,
            row.enabled ? "enabled" : "disabled",
            row.configured ? "configured" : "unconfigured",
            row.models + " models",
            row.unavailable_until ? "unavailable until " + row.unavailable_until : "—",
          ].join("  ") + "\n",
        )
    }
    return 0
  }
  if (["models", "rules"].includes(parsed.verb)) {
    print(
      await call(parsed.verb, {
        attention: parsed.text("attention"),
        status: parsed.text("status"),
        after: parsed.text("after"),
        model: parsed.text("model"),
        side: parsed.values.side === true,
      }),
    )
    return 0
  }
  if (parsed.verb === "extension" || parsed.verb === "web.fetch") {
    if (!terminal.extension) throw new Error("Extension commands are unavailable.")
    const name = parsed.verb === "web.fetch" ? "web.fetch" : word(0, "NAME")
    const value =
      parsed.verb === "web.fetch"
        ? { url: word(0, "URL"), raw: parsed.values.raw === true }
        : parsed.args[1]
          ? Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue))(parsed.args[1])
          : {}
    const result = await terminal.extension(name, value)
    if (name !== "web.fetch") {
      print(result)
      return 0
    }
    const response = object(result)
    const metadata = object(response.structured_content ?? {})
    if (typeof metadata.status_line === "string") terminal.error(metadata.status_line + "\n")
    if (response.is_error) {
      terminal.error(String(response.content) + "\n")
      return 1
    }
    const content = Schema.decodeUnknownSync(Schema.String)(response.content)
    terminal.write(metadata.encoding === "base64" ? Buffer.from(content, "base64") : content)
    return 0
  }
  if (parsed.verb === "env") {
    if (!terminal.extension) throw new Error("Environment commands are unavailable.")
    print(
      await terminal.extension(
        "env",
        clean({ root: parsed.values.clear ? null : parsed.args[0] ? resolve(parsed.args[0]) : undefined }),
      ),
    )
    return 0
  }
  if (["runners", "runner", "set_default_runner"].includes(parsed.verb)) {
    if (!terminal.extension) throw new Error("Runner commands are unavailable.")
    if (parsed.verb === "set_default_runner") {
      print(
        await terminal.extension("set_default_runner", {
          host: word(0, "HOST"),
          runner: word(1, "RUNNER") === "none" ? null : parsed.args[1],
          ...(parsed.text("host-type") ? { kind: parsed.text("host-type")! } : {}),
        }),
      )
      return 0
    }
    if (!parsed.args.length) {
      print(await terminal.extension("runners", {}))
      return 0
    }
    if (parsed.args[0] !== "use" && parsed.args[0] !== "none") throw new Error("runners takes use RUNNER or none.")
    print(await terminal.extension("runners.use", { runner: parsed.args[0] === "none" ? null : word(1, "RUNNER") }))
    return 0
  }
  if (["environment", "environments", "port"].includes(parsed.verb)) {
    if (!terminal.extension) throw new Error("Environment commands are unavailable.")
    if (parsed.verb === "environments") {
      const result = await terminal.extension("environments", {})
      if (parsed.values.json) print(result)
      else {
        const rows = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(result)
        terminal.write(
          rows.length
            ? rows.map(formatEnvironment).join("\n")
            : "No followed conversation has an environment record.\n",
        )
      }
      return 0
    }
    const host = word(0, "CONVERSATION")
    if (parsed.verb === "port" && !parsed.values.clear && (!parsed.text("endpoint") || !parsed.text("token")))
      throw new Error("port requires --endpoint and --token or --clear.")

    const mcp = parsed.text("mcp")
    const servers =
      mcp === undefined
        ? undefined
        : Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.MutableJson)))(
            mcp === "[]" ? mcp : await readFile(mcp, "utf8"),
          )
    if (servers?._tag === "None")
      throw new Error("--mcp requires a JSON file containing an array of MCP servers, or [].")
    const fields =
      parsed.verb === "port"
        ? {
            fs: parsed.values.clear
              ? null
              : {
                  url: parsed.text("endpoint"),
                  token: parsed.text("token"),
                  read: parsed.values.read === true,
                  write: parsed.values.write === true,
                  client: parsed.text("client") ?? "nexus-dev",
                },
          }
        : {
            root: parsed.values.clear ? null : parsed.args[1] ? resolve(parsed.args[1]) : undefined,
            directories: parsed.values.also?.map((path) => resolve(path)),
            mcp: servers?.value,
          }
    const change = clean(fields)
    const result = await terminal.extension(Object.keys(change).length ? "environment.bind" : "environment.read", {
      conversation: await conversation(host),
      ...change,
    })
    if (parsed.values.json) print(result)
    else terminal.write(formatEnvironment(object(result)))
    return 0
  }
  if (parsed.verb === "fetch") {
    if (parsed.values.thumbnail && parsed.values.preview)
      throw new Error("fetch takes --thumbnail or --preview, not both.")
    const file = object(
      await call("fetch", {
        upload: word(0, "UPLOAD"),
        representation: parsed.values.thumbnail ? "thumbnail" : parsed.values.preview ? "preview" : undefined,
      }),
    )
    terminal.write(Buffer.from(Schema.decodeUnknownSync(Schema.String)(file.content), "base64"))
    return 0
  }
  if (parsed.verb === "skills") {
    const action = parsed.args[0]
    if (!action) {
      const skills = object(await call("skills"))
      if (parsed.values.json) print(skills)
      else terminal.write(formatSkills(skills))
      return 0
    }
    const scope = parsed.text("scope") ?? "agent"
    if (action === "push") {
      const skill = await readSkill(join(resolve(word(1, "DIRECTORY")), "SKILL.md"))
      const row = object(
        await call("skill.push", { scope, name: skill.name, description: skill.description, content: skill.body }),
      )

      if (parsed.values.json) print(row)
      else terminal.write(`pushed:    ${row.path} (${row.bytesize} bytes)\n`)

      return 0
    }
    if (!["show", "rm"].includes(action)) throw new Error("skills takes push, show or rm.")
    const result = await call(action === "show" ? "skill.show" : "skill.remove", { scope, name: word(1, "NAME") })
    if (parsed.values.json) print(result)
    else if (action === "show") {
      const body = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }))(result).content
      terminal.write(body.endsWith("\n") ? body : body + "\n")
    }
    return 0
  }
  if (parsed.verb === "prompt") {
    if (parsed.args[0] === "show") {
      print(await call("prompt.show", { slot: parsed.args[1] }))
      return 0
    }
    if (parsed.args[0] !== "preview") throw new Error("prompt takes show or preview.")
    const variables = Object.fromEntries(
      (parsed.values.var ?? []).map((value) => {
        const index = value.indexOf("=")
        if (index < 1) throw new Error("--var requires NAME=VALUE.")
        return [value.slice(0, index), value.slice(index + 1)]
      }),
    )
    const template = parsed.text("template")
    const result = await call("prompt.preview", {
      conversation: await conversation(word(1, "CONVERSATION")),
      prompt: parsed.text("prompt"),
      model: parsed.text("model"),
      answering_user_public_id: parsed.text("to"),
      variables,
      ...(template
        ? {
            template: Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue))(
              template === "-" ? ((await terminal.read?.()) ?? "") : await readFile(template, "utf8"),
            ),
          }
        : {}),
    })
    if (parsed.values.json) print(result)
    else terminal.write(formatPromptPreview(result))
    return 0
  }
  if (parsed.verb === "conversation") {
    if (parsed.args[0] === "cost") {
      if (parsed.args.length < 2 || parsed.args.length > 3)
        throw new Error("Use conversation cost CONVERSATION [AMOUNT|off].")

      const row = object(
        await call("cost", {
          conversation: await conversation(word(1, "CONVERSATION")),
          amount: parsed.args[2] === "off" ? null : parsed.args[2],
        }),
      )
      if (parsed.values.json) {
        print(row)
        return 0
      }

      const usage = object(row.usage_summary)
      const unit = usage.cost_unit ? " " + usage.cost_unit : ""
      terminal.write(
        [
          "conversation: " + row.public_id,
          "known cost: " + (usage.cost_amount ?? "unknown") + unit,
          "cost complete: " + usage.cost_complete,
          "cost limit: " + (row.cost_limit == null ? "off" : row.cost_limit + unit),
          "limit reached: " + row.cost_limit_reached,
          "Changing the limit does not restart work. To continue a held run, use retry RUN_ID [TASK_KEY].",
          "",
        ].join("\n"),
      )
      return 0
    }
    if (parsed.args[0] !== "participants") throw new Error("conversation takes participants or cost.")
    const id = await conversation(word(1, "CONVERSATION"))
    const verb = parsed.args[2]
    if (verb && !["add", "rm", "default"].includes(verb)) throw new Error("participants takes add, rm or default.")
    print(
      await call("participants", {
        conversation: id,
        default: verb === "default" ? word(3, "LEVEL") : undefined,
        principal: verb && verb !== "default" ? word(3, "PRINCIPAL") : undefined,
        level: verb === "add" ? word(4, "LEVEL") : undefined,
        remove: verb === "rm",
      }),
    )
    return 0
  }
  if (parsed.verb === "do" || parsed.verb === "say") {
    const text = parsed.args.slice(parsed.verb === "do" ? 0 : 1).join(" ")
    if (parsed.values.also?.length && !parsed.text("dir")) throw new Error("--also requires --dir.")
    const hasInput = !!text.trim() || !!parsed.values.attach?.length
    if (!hasInput) {
      if (parsed.verb === "say") throw new Error("say requires prompt text or attachments.")
      const fields = inputOptions.filter((field) => parsed.values[field] !== undefined)
      if (fields.length)
        throw new Error("Give prompt text or attachments with " + fields.map((field) => "--" + field).join(", ") + ".")
    }
    const scheduled = !!parsed.text("at") || !!parsed.text("in")
    const delivery =
      parsed.text("mode") ?? (parsed.verb === "say" && !parsed.values.attach?.length && !scheduled ? "steer" : "queue")
    if (delivery !== "queue" && (parsed.values.attach?.length || scheduled))
      throw new Error("Attachments and scheduled inputs require --mode queue.")
    const files = await Promise.all(
      (parsed.values.attach ?? []).map(async (file) => {
        const data = await readFile(file)
        return { name: basename(file), data, mime: attachmentMime(file, data) }
      }),
    )
    const directory = parsed.text("dir")
    const environment = directory
      ? { root: resolve(directory), directories: (parsed.values.also ?? []).map((path) => resolve(path)) }
      : undefined
    const opened =
      parsed.verb === "do"
        ? object(
            await call("open", {
              key: key(),
              runner: parsed.text("runner"),
              environment,
              agent: parsed.text("agent"),
              restricted: parsed.values.restricted === true,
              model: hasInput ? undefined : parsed.text("model"),
              title: parsed.text("title"),
            }),
          )
        : undefined
    const addressed = opened ? undefined : await target(word(0, "HOST"))
    const id = opened
      ? Schema.decodeUnknownSync(Schema.String)(object(opened.conversation).public_id)
      : addressed?.conversation
    const attachments = await Promise.all(
      files.map(async (file) =>
        Schema.decodeUnknownSync(Schema.String)(
          object(await call("upload", { name: file.name, mime: file.mime, content: file.data.toString("base64") }))
            .public_id,
        ),
      ),
    )
    if (addressed?.run && addressed.run === parsed.args[0]) {
      if (
        scheduled ||
        parsed.text("to") ||
        parsed.text("model") ||
        parsed.text("approval") ||
        parsed.text("until") ||
        parsed.text("dir") ||
        typeof parsed.values["code-mode"] === "boolean"
      )
        throw new Error("Scheduling, agent selection and conversation policy require a conversation host.")
      print(await call("run.say", { run: addressed.run, key: key(), text, attachments, delivery }))
      return 0
    }
    if (!id) throw new Error("This host has no conversation.")
    if (typeof parsed.values["code-mode"] === "boolean") {
      if (!terminal.modes) throw new Error("Conversation mode controls are unavailable.")
      await terminal.modes(id, { code_mode: parsed.values["code-mode"] })
    }
    if (!opened && environment) {
      if (!terminal.extension) throw new Error("Conversation environment binding is unavailable.")
      await terminal.extension("environment.bind", { conversation: id, ...environment })
    }
    const host = clean({ conversation: id, environment: opened?.environment })
    if (!hasInput) {
      print(host)
      return 0
    }
    const submitted = object(
      await call("say", {
        conversation: id,
        key: key(),
        text,
        attachments,
        model: parsed.text("model"),
        instructions: parsed.text("instructions"),
        approval: parsed.text("approval"),
        delivery,
        deliver_at: deliveryAt(parsed),
        deliver_in: parsed.text("in"),
        answering_user_public_id: parsed.text("to") ?? parsed.text("agent"),
        reasoning_effort: parsed.text("effort"),
        reasoning_enabled: parsed.values["reasoning-enabled"],
        side: !opened && (await target(id)).side,
        ...(parsed.text("until")
          ? {
              until: {
                command: parsed.text("until"),
                attempts: parsed.number("attempts"),
              },
            }
          : {}),
      }),
    )
    const receipt = object(submitted.input)
    const input = Schema.decodeUnknownSync(Schema.String)(receipt.public_id)
    if (receipt.state === "blocked") {
      print(clean({ ...host, input, status: "blocked", blocked_reason: receipt.blocked_reason }))
      return 0
    }
    const started = performance.now()
    let snapshot = await call("result", { conversation: id, input })
    while (snapshot === null && !scheduled && performance.now() - started < 30000) {
      await setTimeout(250, undefined, { signal: terminal.signal })
      snapshot = await call("result", { conversation: id, input })
    }
    const result = snapshot === null ? { ...host, input, status: "pending" } : { ...host, input, ...object(snapshot) }
    if (snapshot) {
      const execution = object(object(snapshot).execution ?? {})
      if (typeof execution.run_public_id === "string")
        await call("stream.attach", { run: execution.run_public_id, live: parsed.values.stream !== false })
    }
    print(clean(result))
    return 0
  }
  if (parsed.verb === "inputs") {
    const mutation = ["rm", "edit"].includes(parsed.args[0] ?? "")
    const host = word(mutation ? 1 : 0, "HOST")
    const resolved = await target(host)
    const exact = resolved.run === host
    const identity = exact ? { run: host } : { conversation: resolved.conversation }
    if (!exact && !resolved.conversation) throw new Error("This host has no conversation.")
    const prefix = exact ? "run." : ""
    if (exact && (parsed.values.now || parsed.text("at") || parsed.text("in")))
      throw new Error("Scheduling requires a conversation host.")
    if (!mutation) {
      print(await call(prefix + "inputs", identity))
      return 0
    }
    const input = word(2, "INPUT")
    if (parsed.args[0] === "rm") {
      print(await call(prefix + "input.remove", { ...identity, input }))
      return 0
    }
    const text = parsed.args.slice(3).join(" ") || undefined
    if (!text && !parsed.values.now && !parsed.text("at") && !parsed.text("in") && !parsed.text("mode"))
      throw new Error("inputs edit requires new text or a delivery change.")
    const rows = object(await call(prefix + "inputs", identity))
    const row = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(rows.items).find((row) => row.public_id === input)
    if (!row) throw new Error("The queued input does not exist.")
    print(
      await call(prefix + "input.edit", {
        ...identity,
        input,
        version: row.lock_version,
        text,
        delivery: parsed.text("mode"),
        deliver_at: deliveryAt(parsed),
        deliver_in: parsed.values.now ? "0s" : parsed.text("in"),
      }),
    )
    return 0
  }
  if (parsed.verb === "side") {
    const id = parsed.args[0] ? await conversation(parsed.args[0]) : undefined
    print(await call("side", { conversation: id, key: key(), tools: parsed.text("tools") }))
    return 0
  }
  if (["variant", "activate", "rewind", "regenerate"].includes(parsed.verb)) {
    if (parsed.values.conceal && parsed.values.restore) throw new Error("Choose --conceal or --restore.")
    const id = await conversation(word(0, "CONVERSATION"))
    const turn = await turnID(id, word(1, "TURN"), call)
    const idempotencyKey = key()
    if (parsed.verb === "regenerate") terminal.error("idempotency-key: " + idempotencyKey + "\n")
    const action =
      parsed.verb !== "variant"
        ? parsed.verb
        : parsed.args[2]
          ? parsed.values.conceal || parsed.values.restore
            ? "variant.visibility"
            : "variant"
          : "variants"
    const result = await call(action, {
      conversation: id,
      turn,
      variant: parsed.args[2],
      key: idempotencyKey,
      model: parsed.text("model"),
      title: parsed.text("title"),
      restore: parsed.values["keep-checkpoints"] !== true,
      concealed: parsed.values.conceal === true,
    })
    if (["rewind", "regenerate"].includes(parsed.verb)) {
      const record = object(result)
      const restoration = object(record.restoration)
      if (parsed.values.json) print(result)
      else {
        if (record.conversation) {
          terminal.write("conversation: " + object(record.conversation).public_id + "\n")
          const position = /^\d+$/.test(parsed.args[1]) ? " (position " + parsed.args[1] + ")" : ""
          terminal.write("forked_from: " + turn + position + "\n")
        } else terminal.write("turn: " + turn + "\n")
        if (record.variant) terminal.write("variant: " + object(record.variant).public_id + "\n")
        terminal.write(formatRestoration(restoration))
        if (restoration.door_refused) terminal.error("Regeneration refused: " + restoration.door_refused + "\n")
      }
      return restoration.door_refused || ["failed", "partial", "unavailable"].includes(String(restoration.status))
        ? 1
        : 0
    }
    print(result)
    return 0
  }
  if (parsed.verb === "call_tool") {
    const result = object(
      await call("call_tool", {
        runner: word(0, "RUNNER"),
        tool: word(1, "TOOL"),
        input: parsed.args[2] ? Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue))(parsed.args[2]) : {},
        key: key(),
        timeout: parsed.number("timeout") ?? 30000,
      }),
    )
    const detail = object(result.task)
    const task = object(detail.task)
    if (parsed.values.json) print(result)
    else terminal.write("run: " + result.public_id + "\n" + formatTask(detail, task))

    return task.status === "completed" ? 0 : 1
  }
  const host = word(0, "HOST")
  const resolved = await target(host)
  if (parsed.verb === "attach") {
    if (host === resolved.conversation) await call("attach", { conversation: host })
    else await call("stream.attach", { run: host, live: parsed.values.live !== false })
    print(resolved)
    return 0
  }
  if (parsed.verb === "result") {
    if (!resolved.run) throw new Error("This conversation has no materialized run.")
    print(await call("run.result", { run: resolved.run }))
    return 0
  }
  if (parsed.verb === "transcript" && parsed.values.follow) {
    if (!resolved.run) throw new Error("This conversation has no materialized run.")
    return followThread(resolved.run, parsed, terminal)
  }
  if (["watch", "follow"].includes(parsed.verb)) return followDevelopment(resolved, parsed, terminal)
  if (parsed.verb === "stop" && !parsed.args[1] && parsed.text("host-type") !== "run" && resolved.conversation) {
    print(await call("stop", { conversation: resolved.conversation }))
    return 0
  }
  if (parsed.verb === "compact") {
    if (host === resolved.conversation) {
      if (parsed.args[1]) throw new Error("A conversation picks its own round. Omit the task key.")
      print(await call("compact", { conversation: host }))
      return 0
    }
    print(await call("task.compact", { run: host, task: word(1, "a round task key") }))
    return 0
  }
  if (parsed.verb === "turns") {
    if (!resolved.conversation) throw new Error("Turns require a conversation.")
    const after = parsed.number("after")
    const result = await call("turns", {
      conversation: resolved.conversation,
      after_position: after,
      limit: parsed.number("limit"),
    })
    if (parsed.values.json) {
      print(result)
      return 0
    }

    const page = result as unknown as TurnPage & { has_more?: boolean }
    if (!page.items.length) terminal.write(after === undefined ? "(no turns)\n" : `(no turns past position ${after})\n`)
    for (const turn of page.items) {
      const variant = turn.active_variant
      const content = variant?.content?.replace(/\s+/g, " ").trim()
      const prompt = variant?.prompt_text?.replace(/\s+/g, " ").trim()
      const fields = [String(turn.position).padStart(4), turn.public_id, turn.role, turn.kind, turn.status]
      if (variant?.run_public_id) fields.push("run " + variant.run_public_id)
      if (content) fields.push(JSON.stringify(content))
      terminal.write(fields.join("  ") + "\n")
      if (prompt) terminal.write("      said: " + JSON.stringify(prompt) + "\n")
    }
    if (page.has_more)
      terminal.write(`more: bun dev/cli.ts turns ${resolved.conversation} --after ${page.after_position}\n`)
    return 0
  }
  if (
    parsed.verb === "request" &&
    resolved.conversation &&
    parsed.text("host-type") !== "run" &&
    word(0, "HOST") === resolved.conversation
  ) {
    print(
      await call("turn.request", {
        conversation: resolved.conversation,
        turn: await turnID(resolved.conversation, word(1, "TURN"), call),
      }),
    )
    return 0
  }
  if (!resolved.run) throw new Error("This conversation has no materialized run.")
  if (parsed.verb === "append") {
    const file = parsed.text("file") ?? word(1, "-f FILE")
    const text = file === "-" ? await terminal.read?.() : await readFile(file, "utf8")
    if (text === undefined) throw new Error("Standard input is unavailable.")
    const body = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(text)
    print(
      await call("append", {
        run: resolved.run,
        key: key(),
        ...(Array.isArray(body) ? { steps: body } : object(body)),
      }),
    )
    return 0
  }
  const action =
    { stop: "task.cancel", pause: "run.pause", resume: "run.resume", delete: "run.delete" }[parsed.verb] ?? parsed.verb
  if (
    ![
      "task.cancel",
      "run.stop",
      "run.pause",
      "run.resume",
      "run.delete",
      "task.compact",
      "retry",
      "abandon",
      "approve",
      "deny",
      "answer",
      "task",
      "request",
      "graph",
      "phases",
      "transcript",
    ].includes(action)
  )
    throw new Error("Unknown development command: " + parsed.verb)
  const result = await call(parsed.verb === "stop" && !parsed.args[1] ? "run.stop" : action, {
    run: resolved.run,
    task: parsed.args[1],
    force: parsed.verb === "pause" ? parsed.values.force === true : !parsed.values.graceful,
    reason: parsed.args.slice(2).join(" ") || undefined,
    content: parsed.args.slice(2).join(" "),
    token: parsed.text("token"),
    outcome: parsed.text("outcome"),
    model: parsed.text("model"),
    reasoning_effort: parsed.text("effort"),
    reasoning_enabled: parsed.values["reasoning-enabled"],
    always: parsed.values.always === true,
    match: parsed.text("match"),
    prefix: parsed.text("prefix"),
    limit: parsed.number("limit"),
    before: parsed.text("before"),
  })
  if (parsed.verb === "task") {
    const detail = object(result)
    const task = object(detail.task)
    const hint = heldTaskHint(task)
    if (hint) terminal.error(hint + "\n")
    if (parsed.values.json) print(result)
    else terminal.write(formatTask(detail, task))

    return 0
  }
  if (parsed.verb === "approve") {
    const response = object(result)
    const grant = response.grant === undefined ? undefined : object(response.grant)

    if (grant) {
      if (parsed.values.json) print(result)
      else {
        terminal.write("approved: " + parsed.args[1] + "\n")
        if (typeof grant.refused === "string") {
          terminal.error("The call was approved. The session grant was refused (" + grant.refused + ").\n")
        } else if (grant.already === true) {
          terminal.write("granted: (already granted this session)\n")
        } else {
          const rule = object(grant.rule)
          const pattern = rule.match === undefined ? "" : " " + rule.path + " = " + JSON.stringify(rule.match)

          terminal.write("granted: " + rule.tool + pattern + "\n")
        }
      }

      return typeof grant.refused === "string" ? 1 : 0
    }
  }
  if (parsed.verb === "phases" && !parsed.values.json) {
    terminal.write(formatPhases(result))
    return 0
  }
  if (parsed.verb === "transcript" && !parsed.values.json) {
    const page = object(result)
    const rounds = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(page.rounds)
    for (const row of rounds) terminal.write(formatRound(row))
    if (!rounds.length)
      terminal.write(parsed.text("prefix") ? "(nothing under " + parsed.text("prefix") + ")\n" : "(no rounds yet)\n")
    if (page.has_older) terminal.write("older: " + page.next_before + "\n")
    return 0
  }
  if (parsed.verb === "graph" && !parsed.values.json) terminal.write(String(object(result).mermaid) + "\n")
  else print(result)
  return 0
}

function clean(value: unknown): JsonObject {
  return Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue))(JSON.stringify(value))
}

function deliveryAt(parsed: ReturnType<typeof parseDevelopment>) {
  if (parsed.values.now) {
    if (parsed.text("at") || parsed.text("in")) throw new Error("Choose only one of --at, --in or --now.")
    return undefined
  }
  if (parsed.text("at") && parsed.text("in")) throw new Error("Choose --at or --in.")
  const time = parsed.text("at")
  if (time) {
    const instant = Date.parse(time)
    if (!Number.isFinite(instant)) throw new Error("--at requires an ISO date/time.")
    return new Date(instant).toISOString()
  }
  return undefined
}

async function turnID(
  conversation: string,
  reference: string,
  call: (action: string, fields: JsonObject) => Promise<JsonValue>,
) {
  if (!/^\d+$/.test(reference)) return reference
  const rows = object(await call("turns", { conversation, before_position: Number(reference) + 1, limit: 1 }))
  const turn = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(rows.items).find(
    (row) => row.position === Number(reference),
  )
  if (!turn) throw new Error("Turn " + reference + " does not exist.")
  return String(turn.public_id)
}

function formatEnvironment(row: JsonObject) {
  const { mcp, ...fields } = row
  const report = mcp && !Array.isArray(mcp) ? object(mcp) : undefined
  const servers = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        state: Schema.String,
        fault: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  )(Array.isArray(mcp) ? mcp : (report?.servers ?? []))

  return (
    formatDevelopment(fields) +
    [
      ...servers.map(
        (server) => "mcp: " + server.name + "  " + server.state + (server.fault ? " — " + server.fault : ""),
      ),
      ...(report && !report.servers ? [formatDevelopment(report).trimEnd()] : []),
    ]
      .map((line) => line + "\n")
      .join("")
  )
}

function formatSkills(skills: JsonObject) {
  return ["agent", "workspace", "project"]
    .map((scope) => {
      if (scope === "project" && skills.project == null) return "project (no runner root set)\n"

      const header = scope === "project" ? "project (announced by this runner)" : scope + "/"
      const rows = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(skills[scope])
      const items = rows.map((row) => "  " + row.name + (row.description ? ": " + row.description : ""))
      return [header, ...(items.length ? items : ["  (none)"])].join("\n") + "\n"
    })
    .join("")
}

function formatRestoration(restoration: JsonObject) {
  const lines = ["restoration: " + restoration.status + (restoration.reason ? ": " + restoration.reason : "")]
  for (const row of Schema.decodeUnknownSync(Schema.Array(ObjectValue))(restoration.runners)) {
    const details = [
      row.checkpoint,
      row.reason,
      row.undo && "(undo " + row.undo + ")",
      row.skipped && "(skipped: " + JSON.stringify(row.skipped) + ")",
      ...["outside", "ignored"].flatMap((key) =>
        Array.isArray(row[key]) && row[key].length ? ["[" + key + ": " + row[key].join(", ") + "]"] : [],
      ),
    ].filter(Boolean)
    lines.push(["runner:", row.runner_executor_public_id, row.status, ...details].join(" "))
  }
  return lines.join("\n") + "\n"
}

function formatPhases(result: JsonValue) {
  const report = object(result)
  const rows = Schema.decodeUnknownSync(Schema.Array(ObjectValue))
  const phases = rows(report.phases)
  const background = rows(report.background)
  const spend = object(report.spend)
  const byModel = Object.entries(object(spend.by_model ?? {}))
  const usage = (part: JsonObject) =>
    part.input_tokens +
    " in, " +
    part.output_tokens +
    " out" +
    (part.cost_amount == null ? "" : (" — " + part.cost_amount + " " + (part.cost_unit ?? "")).trimEnd())

  return (
    [
      ...(phases.length
        ? phases.map(
            (phase, index) =>
              (index === report.current ? "> " : "  ") +
              phase.label +
              "  " +
              phase.done +
              "/" +
              phase.total +
              "  " +
              phase.status,
          )
        : ["(no phases yet)"]),
      ...background.map(
        (task) =>
          "background: " +
          task.key +
          " " +
          task.status +
          (task.result_delivered_at ? "  (delivered " + task.result_delivered_at + ")" : ""),
      ),
      "spend:     " + usage(spend),
      ...(byModel.length > 1 ? byModel.map(([model, part]) => "  " + model + "  " + usage(object(part))) : []),
    ].join("\n") + "\n"
  )
}

function formatTask(detail: JsonObject, task: JsonObject) {
  const lines = ["task: " + task.key + " (" + task.kind + ") " + task.status]
  if (task.tool_name) lines.push("tool: " + (mcpTaskLabel(task) ?? task.tool_alias ?? task.tool_name))
  if (detail.tool_input != null) lines.push("input: " + JSON.stringify(detail.tool_input))
  if (detail.prompt) lines.push("asked: " + detail.prompt)
  if (Array.isArray(detail.options))
    lines.push("options: " + detail.options.join(" | ") + (detail.multi ? " (multiple)" : ""))
  if (task.error) {
    const error = object(task.error)
    lines.push("error: " + [error.key, error.detail].filter(Boolean).join(" — "))
  }
  if (task.approval) {
    const fact = object(task.approval)
    lines.push("approval: " + fact.origin + (fact.decided_by ? " (" + fact.decided_by + ") at " + fact.decided_at : ""))
  }
  if (detail.title) lines.push("title: " + detail.title)
  if (detail.metadata != null) lines.push("metadata: " + JSON.stringify(detail.metadata))
  if (detail.structured_content != null || (task.tool_name === "code" && detail.structured_content === null))
    lines.push("structure: " + JSON.stringify(detail.structured_content))

  if (Array.isArray(detail.content)) {
    for (const block of Schema.decodeUnknownSync(Schema.Array(ObjectValue))(detail.content)) {
      if (block.type === "text") lines.push(String(block.text))
      else if (block.type === "resource_link") {
        const facts = [block.mimeType, block.size != null && block.size + " B"].filter(Boolean).join(", ")
        const id = String(block.uri).replace(/^nexus:\/\/uploads\//, "")
        lines.push("link: " + [block.name, facts && "(" + facts + ")", id].filter(Boolean).join(" "))
      }
    }
  } else {
    const text = detail.content ?? detail.output ?? detail.output_preview
    if (typeof text === "string") lines.push(text)
  }
  return lines.join("\n") + "\n"
}

function mcpTaskLabel(task: JsonObject) {
  const target = object(task.target ?? {})
  if (target.kind !== "mcp") return
  const connection =
    target.display_name && target.connection_public_id
      ? target.display_name + " (" + target.connection_public_id + ")"
      : target.display_name || target.connection_public_id
  const facts = [connection, target.account_label, target.tool_name || task.tool_name].filter(Boolean).join(" · ")
  return (task.tool_alias || task.tool_name || task.key) + " [MCP " + facts + "]"
}

function heldTaskHint(task: JsonObject) {
  if (
    task.kind !== "model_task" ||
    task.failure_resolution ||
    !["timed_out", "failed", "uncertain"].includes(String(task.status))
  )
    return
  const key = object(task.error ?? {}).key
  if (task.on_failure !== "absorb" || key === "conversation_cost_limit_reached") return modelRecoveryHint(key)
}

function formatRound(row: JsonObject) {
  const calls = object(row.calls ?? {})
  const items = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(calls.items ?? [])
  const count = Number(calls.count ?? items.length)
  const header = [String(row.task_key) + (row.mainline === false ? " (branch)" : ""), row.status]
  if (count) header.push(count + (count === 1 ? " call" : " calls"))
  const usage = object(row.usage ?? {})
  if (typeof usage.total_tokens === "number") header.push(usage.total_tokens + "t")
  const lines = [header.join("  ")]
  for (const call of items) {
    lines.push(
      "  " + (call.is_error ? "! " : "- ") + call.name + " " + call.status + (call.title ? " — " + call.title : ""),
    )
    if (call.output_preview) lines.push("    " + call.output_preview)
  }
  if (count > items.length) lines.push("  … " + (count - items.length) + " more calls")
  if (Array.isArray(row.branches) && row.branches.length) lines.push("  branches: " + row.branches.join(", "))
  if (row.text_preview) lines.push("  " + row.text_preview)
  if (row.error) lines.push("  ! " + object(row.error).key)
  return lines.join("\n") + "\n"
}

async function followThread(run: string, parsed: ReturnType<typeof parseDevelopment>, terminal: DevelopmentTerminal) {
  const call = (action: string, fields: Record<string, unknown> = {}) =>
    terminal.command(clean({ action, addressed: true, ...fields }))
  const started = performance.now()
  const timeout = parsed.number("timeout")
  const limit = parsed.number("limit")
  const opened = object(await call("stream.open", { run, live: true }))
  const stream = Schema.decodeUnknownSync(Schema.String)(opened.stream)
  const thread = new ThreadAccumulator()
  const seen = new Map<string, string>()
  const print = (row: JsonObject) => {
    const signature = JSON.stringify(row)
    const key = String(row.task_key)
    if (seen.get(key) === signature) return
    seen.set(key, signature)
    terminal.write(parsed.values.json ? signature + "\n" : formatRound(row))
  }
  // The worker transports JSON from the typed SDK transcript and channel readers.
  const seed = async (before?: string) => {
    const page = (await call("transcript", { run, before, limit })) as unknown as RunTranscript
    thread.seed(page).forEach(print)
    if (page.has_older) terminal.error("older: " + page.next_before + "\n")
  }
  let observedRunning = false
  let live = ""
  try {
    await seed(parsed.text("before"))
    while (!terminal.signal.aborted) {
      const events = object(await call("stream.poll", { stream }))
      if (events.lost) {
        terminal.error(`Live stream skipped ${events.lost} buffered events. Refreshing the transcript.\n`)
        await seed()
      }
      for (const event of Schema.decodeUnknownSync(Schema.Array(ObjectValue))(events.events)) {
        if (event.channel === "notice") {
          terminal.error(String(event.message) + "\n")
          continue
        }
        if (event.channel === "resync") {
          await seed()
          continue
        }
        const frame = object(event.frame)
        if (frame.run_public_id && frame.run_public_id !== run) continue
        if (event.channel === "transcript") {
          const item = frame as unknown as TranscriptItem
          if (item.type === "round") {
            const settled = thread.settleRound(item)
            if (settled) print(settled)
          }
          if (item.type === "call") thread.settleCall(item)
        }
        if (event.channel === "progress") {
          const progress = frame as unknown as ProgressFrame
          if (progress.type === "round_started") thread.roundStarted(progress)
          if (progress.type === "step_started") thread.stepStarted(progress)
          if (progress.type === "step_claimed") thread.stepClaimed(progress)
        }
        const next = thread.live.join(", ")
        if (next === live) continue
        live = next
        terminal.write(
          parsed.values.json ? JSON.stringify({ live: thread.live }) + "\n" : "live: " + (next || "(nothing)") + "\n",
        )
      }
      const info = object(await call("run", { run }))
      if (["completed", "failed", "canceled"].includes(String(info.status))) {
        if (observedRunning || parsed.text("before") === undefined) await seed()
        return info.status === "completed" ? 0 : 1
      }
      observedRunning = true
      if (timeout !== undefined && performance.now() - started >= timeout * 1000)
        throw new Error("Timed out watching " + run)
      await setTimeout(100, undefined, { signal: terminal.signal })
    }
    return 130
  } finally {
    await call("stream.close", { stream }).catch(() => {})
  }
}

async function followDevelopment(
  target: typeof Target.Type,
  parsed: ReturnType<typeof parseDevelopment>,
  terminal: DevelopmentTerminal,
) {
  const seen = new Map<string, string>()
  const text = new TranscriptAccumulator()
  const reasoning = new TranscriptAccumulator()
  const started = performance.now()
  const call = (action: string, fields: Record<string, unknown> = {}) =>
    terminal.command(clean({ action, addressed: true, ...fields }))
  const deadline = parsed.number("timeout")
  const state: { stream?: string; execution?: string; turn?: string | null } = {}
  let printed = false
  let midLine: "text" | "reasoning" | undefined
  const breakLine = () => {
    if (midLine) terminal.write("\n")
    midLine = undefined
  }
  const markRestart = () => {
    if (!printed) return

    breakLine()
    terminal.write("(restarted — the text above was discarded)\n")
    printed = false
  }
  const reset = () => {
    markRestart()
    text.reset()
    reasoning.reset()
  }
  const wait = (interval: number) => {
    const remaining = deadline === undefined ? Infinity : deadline * 1000 - (performance.now() - started)
    if (remaining <= 0) throw new Error("Timed out watching " + (target.run ?? target.conversation))

    return setTimeout(Math.min(interval, remaining), undefined, { signal: terminal.signal })
  }
  const partial = (value: string, channel: "text" | "reasoning", delta = false, length?: number, inferReset = true) => {
    if (channel === "text" ? parsed.values.stream === false : !parsed.values.reasoning) return

    const accumulator = channel === "text" ? text : reasoning
    const output = delta
      ? accumulator.accumulate(value)
      : length === undefined
        ? accumulator.replaceOnSettle(value)
        : accumulator.replaceSnapshot(value, length)
    if (!delta && inferReset && accumulator.replaced) {
      const other = channel === "text" ? reasoning : text
      markRestart()
      other.reset()
    }
    if (!output) return

    if (midLine && midLine !== channel) breakLine()
    terminal.write(output)
    printed = true
    midLine = output.endsWith("\n") ? undefined : channel
  }
  const snapshot = (row: JsonObject) => {
    for (const channel of ["reasoning", "text"] as const) {
      const value = row[channel]
      const length = row[channel + "_length"]
      if (typeof value === "string")
        partial(value, channel, false, typeof length === "number" ? length : undefined, row.reset === undefined)
    }
  }
  try {
    while (!terminal.signal.aborted) {
      if (!target.run && target.conversation)
        target = Schema.decodeUnknownSync(Target)(await call("target", { host: target.conversation }))
      const execution = target.run ?? target.variant
      if (!execution) {
        await wait(250)
        continue
      }
      if (state.execution !== execution) {
        if (state.stream) await call("stream.close", { stream: state.stream })
        const opened = object(
          await call("stream.open", {
            ...(target.run
              ? { run: target.run }
              : { conversation: target.conversation, turn: target.turn, variant: target.variant }),
            live: parsed.values.stream !== false || parsed.values.reasoning,
          }),
        )
        state.stream = Schema.decodeUnknownSync(Schema.String)(opened.stream)
        if (target.turn && target.turn === state.turn) reset()
        else {
          breakLine()
          printed = false
          text.reset()
          reasoning.reset()
        }
        state.turn = target.turn
        state.execution = execution
        snapshot(opened)
        seen.clear()
      }
      const events = object(await call("stream.poll", { stream: state.stream }))
      const lost = Number(events.lost ?? 0) > 0
      if (lost) {
        terminal.error(`Live stream skipped ${events.lost} buffered events. Restoring transcript snapshot.\n`)
        if (events.reset) reset()
        snapshot(events)
      }
      for (const event of Schema.decodeUnknownSync(Schema.Array(ObjectValue))(events.events)) {
        if (event.channel === "notice") {
          terminal.error(String(event.message) + "\n")
          continue
        }
        if (event.channel === "resync") continue
        const frame = object(event.frame)
        const payload = frame.payload ?? {}
        if (typeof payload !== "object" || Array.isArray(payload)) continue
        if (event.channel === "events" && frame.type === "input_accepted") {
          if (target.conversation && parsed.args[0] !== target.conversation && !payload.run_public_id) continue
          if (typeof payload.deliver_at === "string" && typeof payload.input_public_id === "string") {
            const key = "scheduled:" + payload.input_public_id
            if (seen.get(key) === payload.deliver_at) continue

            seen.set(key, payload.deliver_at)
            breakLine()
            terminal.write(
              parsed.values.json
                ? JSON.stringify(frame) + "\n"
                : `scheduled: ${payload.input_public_id} for ${payload.deliver_at}\n`,
            )
            continue
          }
        }
        // The snapshot already includes transcript deltas and resets through this poll's cursor.
        if (
          lost &&
          event.channel === "transcript" &&
          ["stream_reset", "text_delta", "reasoning_delta"].includes(String(frame.type))
        )
          continue
        if (event.channel === "transcript" && frame.type === "stream_reset") {
          reset()
          continue
        }
        if (event.channel === "transcript" && typeof payload.text === "string") {
          if (frame.type === "text_delta") partial(payload.text, "text", true)
          if (frame.type === "reasoning_delta") partial(payload.text, "reasoning", true)
          continue
        }
        if (parsed.verb === "follow" || event.channel === "progress") {
          breakLine()
          terminal.write(parsed.values.json ? JSON.stringify(frame) + "\n" : formatDevelopment(frame))
        }
      }
      if (!target.run) {
        if (["completed", "canceled", "failed", "timed_out"].includes(target.status ?? "")) {
          if (typeof target.content === "string") partial(target.content, "text")
          breakLine()
          terminal.write("status: " + target.status + "\n")
          return target.status === "completed" ? 0 : 1
        }
        await wait(100)
        continue
      }
      const info = object(await call("run", { run: target.run }))
      const tasks = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(info.tasks ?? [])

      for (const task of tasks) {
        const signature = JSON.stringify(task)
        const key = String(task.key)
        if (seen.get(key) === signature) continue
        seen.set(key, signature)
        breakLine()
        terminal.write(
          parsed.values.json
            ? JSON.stringify(task) + "\n"
            : `${task.status}  ${key}${task.tool_name ? "  " + (mcpTaskLabel(task) ?? task.tool_name) : ""}${task.error ? "  " + JSON.stringify(task.error) : ""}\n`,
        )
        const hint = heldTaskHint(task)
        if (hint) terminal.error(hint + "\n")
        if (["awaiting_input", "needs_approval"].includes(String(task.status))) {
          const detail = await call("task", { run: target.run, task: key })
          terminal.write(parsed.values.json ? JSON.stringify(detail) + "\n" : formatDevelopment(detail))
        }
      }
      if (parsed.values.stream !== false) {
        const result = object(await call("run.result", { run: target.run }))
        if (typeof result.output === "string") partial(result.output, "text")
      }
      const turnStatus = object(info.turn ?? {}).status
      const status = ["completed", "failed", "canceled", "timed_out"].includes(String(turnStatus))
        ? turnStatus
        : info.status
      if (["completed", "canceled", "failed", "timed_out", "needs_attention"].includes(String(status))) {
        if (target.conversation && parsed.args[0] === target.conversation && parsed.text("host-type") !== "run") {
          const next = Schema.decodeUnknownSync(Target)(await call("target", { host: target.conversation }))
          if ((next.run ?? next.variant) && (next.run ?? next.variant) !== execution) {
            target = next
            continue
          }
        }
        breakLine()
        terminal.write("status: " + status + "\n")
        if (
          parsed.verb === "watch" &&
          !parsed.values.json &&
          !["completed", "failed", "canceled"].includes(String(info.status))
        ) {
          if (turnStatus === "failed")
            terminal.write(`holding: use retry ${target.run} [TASK] or answer ${target.run} TASK TEXT to continue\n`)
          if (turnStatus === "completed")
            for (const task of tasks) {
              if (["completed", "failed", "timed_out", "uncertain", "canceled", "skipped"].includes(String(task.status)))
                continue

              terminal.write(`background: ${task.key} ${task.status} — its result reaches the next turn\n`)
            }
        }
        return status === "completed" ? 0 : 1
      }
      await wait(100)
    }
    return 130
  } finally {
    if (state.stream) await call("stream.close", { stream: state.stream }).catch(() => {})
  }
}

function formatPromptPreview(value: JsonValue) {
  const estimate = object(value)
  const history = object(estimate.history)
  const lines = [
    "tokens: " +
      estimate.input_tokens +
      (estimate.tokenizer_exact ? " (exact)" : " (estimated)") +
      " · limit " +
      (estimate.catalog_input_token_limit ?? "-") +
      " · advisory " +
      (estimate.advisory_input_token_limit ?? "-"),
    "history: selected " +
      history.selected +
      " · skipped " +
      history.skipped +
      (history.skipped_reason ? " (" + history.skipped_reason + ")" : "") +
      " · compacted " +
      history.compacted,
  ]
  if (!estimate.rendered) return lines.join("\n") + "\n"

  const rendered = object(estimate.rendered)
  const storage = object(rendered.storage)
  const memory = object(rendered.memory)
  const blocks = Schema.decodeUnknownSync(Schema.Array(ObjectValue))(rendered.blocks)

  return [
    "mechanism: " + rendered.mechanism,
    ...lines,
    "storage: " +
      storage.bytes +
      " of " +
      storage.bound +
      " bytes (" +
      (storage.within_bound ? "within bound" : "over: " + storage.refusal) +
      ")",
    "blocks:",
    ...blocks.map(
      (block) =>
        "  " +
        [
          block.index,
          block.block,
          block.type,
          block.role ?? "-",
          block.state,
          block.tokens + " / " + (block.allocated_tokens ?? "-"),
        ].join(" · "),
    ),
    "memory: " + memory.included + " included · " + memory.omitted + " omitted",
    "slots: " + JSON.stringify(rendered.slots),
    "",
    "entries:",
    JSON.stringify(rendered.entries, null, 2),
    "",
  ].join("\n")
}

export function formatAdaptationInspection(value: JsonValue, json: boolean) {
  if (json) return JSON.stringify(value, null, 2) + "\n"

  const result = object(value)
  const row = object(result.adaptations ?? {})
  const facts = result.facts && object(result.facts)
  return (
    [
      "Model: " + (result.model ?? "(no default model)"),
      "Row: " + (row.row ?? "unknown") + (row.path ? " (" + row.path + ")" : ""),
      row.selection && "Selection: " + row.selection + (row.matched ? " (" + row.matched + ")" : ""),
      Array.isArray(row.models) && "Model patterns: " + (row.models.join(", ") || "(none)"),
      Array.isArray(row.tool_style) && "Tool style: " + row.tool_style.join(", "),
      row.tool_descriptions !== undefined && "Tool descriptions: " + row.tool_descriptions,
      ...(Array.isArray(row.recuts) ? row.recuts.map((recut) => "Recut: " + recut) : []),
      row.summarizer && "Summarizer: " + row.summarizer,
      Array.isArray(row.lead_hints) && "Lead hints: " + (row.lead_hints.join(", ") || "(none)"),
      row.boot_row && "Boot row: " + row.boot_row,
      "Catalog: " +
        (result.catalog_error ?? (facts ? JSON.stringify(facts.capabilities) : "model unavailable or unknown")),
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  )
}

export function formatDevelopment(value: JsonValue): string {
  if (value === null) return "(none)\n"
  if (typeof value === "string") return value + "\n"
  if (typeof value !== "object") return String(value) + "\n"
  if (Array.isArray(value)) return value.map(formatDevelopment).join("")
  if ("output" in value && "status" in value)
    return (
      "status: " +
      value.status +
      "\n" +
      (value.output === null ? "output: (none — this run resolved no deliverable)\n" : String(value.output) + "\n")
    )
  if (typeof value.content === "string") return value.content + "\n"
  if (value.execution && typeof value.execution === "object" && !Array.isArray(value.execution))
    return (
      [
        value.conversation && "conversation: " + value.conversation,
        value.input && "input: " + value.input,
        value.environment && "environment: " + JSON.stringify(value.environment),
        ...Object.entries(value.execution).map(([key, id]) => key.replace("_public_id", "") + ": " + id),
        value.status && "status: " + value.status,
      ]
        .filter(Boolean)
        .join("\n") + "\n"
    )
  if (Array.isArray(value.items)) return formatDevelopment(value.items)
  return (
    Object.entries(value)
      .map(([key, field]) => `${key}: ${typeof field === "object" ? JSON.stringify(field) : String(field)}`)
      .join("\n") + "\n"
  )
}

function attachmentMime(file: string, data: Buffer) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg"
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString("ascii"))) return "image/gif"
  if (data.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf"
  if (data.subarray(0, 4).toString("ascii") === "RIFF") {
    const kind = data.subarray(8, 12).toString("ascii")
    if (kind === "WEBP") return "image/webp"
    if (kind === "WAVE") return "audio/wav"
  }
  if (data.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg"
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
    }[extname(file).toLowerCase()] ?? "application/octet-stream"
  )
}
