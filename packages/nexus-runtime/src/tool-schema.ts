import { Ajv, type ValidateFunction } from "ajv"
import { Ajv2020 } from "ajv/dist/2020.js"
import type { Schema } from "effect"

/** Use the same JSON Schema dialects as extension configuration and MCP discovery. */
export function compileToolSchema(schema: Schema.JsonObject): ValidateFunction<unknown> {
  return (
    /draft-0[467]/.test(String(schema.$schema))
      ? new Ajv({ strict: false, validateFormats: false })
      : new Ajv2020({ strict: false, validateFormats: false })
  ).compile<unknown>(schema)
}

export function toolInputRefusal(validator: ValidateFunction<unknown>, input: unknown) {
  if (validator(input)) return
  return (
    "invalid_tool_arguments: " +
    (validator.errors ?? [])
      .slice(0, 3)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ")
  ).slice(0, 512)
}
