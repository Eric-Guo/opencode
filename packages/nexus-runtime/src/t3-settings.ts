export const t3Configuration = {
  type: "object",
  additionalProperties: false,
  properties: {
    server: { enum: ["host", "local"] },
    listen_port: { type: "integer", minimum: 1, maximum: 65535 },
    url: { type: "string" },
    token: { type: "string", writeOnly: true },
    project: { type: "string" },
    project_id: { type: "string" },
    default_agent: { type: "string" },
    workspace: {
      oneOf: [
        { type: "object", properties: { type: { const: "root" } }, required: ["type"], additionalProperties: false },
        {
          type: "object",
          properties: { type: { const: "existing_worktree" }, worktreePath: { type: "string", minLength: 1 } },
          required: ["type", "worktreePath"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { const: "worktree" },
            baseRef: { type: "string", minLength: 1 },
            branch: { type: "string" },
          },
          required: ["type", "baseRef"],
          additionalProperties: false,
        },
      ],
    },
  },
} as const
