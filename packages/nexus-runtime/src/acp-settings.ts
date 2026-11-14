import { access, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { delimiter, isAbsolute, resolve } from "node:path"
import { JsonSchema, Schema } from "effect"

const Row = Schema.Struct({
  command: Schema.NonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
  description: Schema.NonEmptyString,
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  permissions: Schema.optional(Schema.Literals(["allow", "reject", "ask"])),
  timeout_ms: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3600000))),
  auth_method: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  model: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  enabled: Schema.optional(Schema.Boolean),
})
const Legacy = Schema.NonEmptyArray(Schema.NonEmptyString)

export type AcpAgent = {
  name: string
  command: string
  args: readonly string[]
  description: string
  env: Record<string, string>
  permissions: "allow" | "reject" | "ask"
  timeout_ms: number
  auth_method: string | null
  model: string | null
  enabled: boolean
  secrets: string[]
}

export const acpConfiguration = {
  type: "object",
  properties: {
    agents: {
      type: "object",
      additionalProperties: {
        // Opaque rows are diagnosed independently so one broken agent leaves its siblings available.
        type: ["object", "array"],
        properties: { env: { type: "object", writeOnly: true } },
      },
    },
  },
  required: ["agents"],
  additionalProperties: false,
} satisfies JsonSchema.JsonSchema

export function acpSettings(input: unknown, environment: NodeJS.ProcessEnv = process.env) {
  const table = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(input)
  const agents: AcpAgent[] = []
  const faults: { name: string; issue: string }[] = []
  Object.entries(table).forEach(([name, value]) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 32)
      throw new Error("ACP agent names must use lowercase letters, digits and single hyphens, up to 32 characters.")
    const legacy = Array.isArray(value) ? Schema.decodeUnknownOption(Legacy)(value) : undefined
    const decoded = Schema.decodeUnknownOption(Row, { onExcessProperty: "error" })(
      legacy?._tag === "Some"
        ? { command: legacy.value[0], args: legacy.value.slice(1), description: name, permissions: "ask" }
        : value,
    )
    if (
      decoded._tag === "None" ||
      !decoded.value.description.trim() ||
      decoded.value.auth_method?.trim() === "" ||
      decoded.value.model?.trim() === ""
    ) {
      faults.push({
        name,
        issue:
          "Invalid row: provide command and description; check args, env, permissions, timeout_ms, auth_method, model and enabled.",
      })
      return
    }
    const row = decoded.value
    const secrets: string[] = []
    const missing = new Set<string>()
    const env = Object.fromEntries(
      Object.entries(row.env ?? {}).map(([key, value]) => {
        const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
          const found = environment[variable]
          if (found === undefined) {
            missing.add(variable)
            return ""
          }
          if (found) secrets.push(found)
          return found
        })
        if (expanded && /(?:token|secret|password|api.?key|credential|authorization)/i.test(key)) secrets.push(expanded)
        return [key, expanded]
      }),
    )
    if (missing.size) {
      faults.push({ name, issue: "Unset environment variables: " + [...missing].join(", ") })
      return
    }
    agents.push({
      name,
      command: row.command,
      args: row.args ?? [],
      description: row.description.trim(),
      env,
      permissions: row.permissions ?? "allow",
      timeout_ms: row.timeout_ms ?? 600000,
      auth_method: row.auth_method ?? null,
      model: row.model ?? null,
      enabled: row.enabled ?? true,
      secrets: [...new Set(secrets)].sort((left, right) => right.length - left.length),
    })
  })
  return { agents, faults }
}

export function acpEnvironment(agent: AcpAgent) {
  return {
    ...Object.fromEntries(
      [
        "HOME",
        "PATH",
        "LANG",
        "LC_ALL",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "WINDIR",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PATHEXT",
        "COMSPEC",
      ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    ),
    ...agent.env,
  }
}

export async function acpExecutable(agent: AcpAgent, cwd?: string) {
  const paths = acpEnvironment(agent).PATH?.split(delimiter) ?? []
  if (
    !cwd &&
    ((!isAbsolute(agent.command) && /[\\/]/.test(agent.command)) || paths.some((entry) => !isAbsolute(entry)))
  )
    return
  const directories = /[\\/]/.test(agent.command) ? [""] : paths
  const suffixes =
    process.platform === "win32" && !/\.(?:exe|cmd|bat|com)$/i.test(agent.command)
      ? (acpEnvironment(agent).PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""]
  const found = await Promise.all(
    directories.flatMap((directory) =>
      suffixes.map(async (suffix) => {
        const path = resolve(cwd ?? ".", directory, agent.command + suffix)
        return await Promise.all([access(path, constants.X_OK), stat(path)]).then(
          (result) => (result[1].isFile() ? path : undefined),
          () => undefined,
        )
      }),
    ),
  )
  const executable = found.find((entry) => entry)
  if (!executable)
    throw new Error('ACP agent "' + agent.name + '": executable not found; install it or correct command and PATH.')
  return executable
}
