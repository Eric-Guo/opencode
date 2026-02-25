import z from "zod"

export const ConfigShape = {
  worktree: z.object({
    directory: z.string(),
  }),
  daytona: z.object({
    name: z.string(),
  }),
} as const

export const Config = z.discriminatedUnion("type", [
  ConfigShape.worktree.extend({
    type: z.literal("worktree"),
  }),
  ConfigShape.daytona.extend({
    type: z.literal("daytona"),
  }),
])

export type Config = z.infer<typeof Config>
export type ConfigKind = keyof typeof ConfigShape
export type ConfigValue = {
  [K in ConfigKind]: z.infer<(typeof ConfigShape)[K]>
}

export function toValue(config: Config): ConfigValue[Config["type"]] {
  switch (config.type) {
    case "worktree":
      return {
        directory: config.directory,
      }
    case "daytona":
      return {
        name: config.name,
      }
  }
}

export function toConfig<K extends ConfigKind>(type: K, value: ConfigValue[K]): Extract<Config, { type: K }> {
  return {
    type,
    ...value,
  } as Extract<Config, { type: K }>
}
