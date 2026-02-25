import z from "zod"

export const ConfigShape = {
  worktree: z.object({
    directory: z.string(),
  }),
} as const

export const Config = z.discriminatedUnion("type", [
  ConfigShape.worktree.extend({
    type: z.literal("worktree"),
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
  }
}

export function toConfig<K extends ConfigKind>(type: K, value: ConfigValue[K]): Extract<Config, { type: K }> {
  return {
    type,
    ...value,
  } as Extract<Config, { type: K }>
}
