const credentialName = /key|password|passwd|secret|token|credential/i

export function integrationValues(
  values: Readonly<Record<string, string>>,
  environment: NodeJS.ProcessEnv,
  options: { literal?: boolean; headers?: boolean; extraCredential?: RegExp } = {},
) {
  const secrets: string[] = []
  const missing = new Set<string>()
  const resolved = Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      const expanded = options.literal
        ? value
        : value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
            const found = Object.hasOwn(environment, variable) ? environment[variable] : undefined
            if (!found) {
              missing.add(variable)
              return ""
            }

            secrets.push(found)
            return found
          })

      if (options.headers || credentialName.test(name) || options.extraCredential?.test(name)) secrets.push(expanded)

      return [name, expanded]
    }),
  )
  return { resolved, secrets, missing }
}

export function integrationSecrets(values: readonly string[]) {
  return [...new Set(values.filter((value) => Buffer.byteLength(value) >= 8))].sort(
    (left, right) => Buffer.byteLength(right) - Buffer.byteLength(left),
  )
}

export function mcpChildEnvironment(values: Readonly<Record<string, string>>) {
  const scrubbed = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      !credentialName.test(entry[0]) &&
      !/^(?:OPENCODE_|NEXUS_|CYBROS_|RHO_|BUNDLE_|BUNDLER_|RUBYOPT$|RUBYLIB$|GEM_HOME$|GEM_PATH$)/i.test(entry[0]),
  )

  return { ...Object.fromEntries(scrubbed), PYTHONUNBUFFERED: "1", ...values }
}
