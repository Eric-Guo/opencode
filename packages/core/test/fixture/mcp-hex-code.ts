import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "hex-code", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "color",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { color: { type: "string", format: "hex-code" } },
          required: ["color"],
        },
      },
    ],
  }),
)

server.setRequestHandler(CallToolRequestSchema, () =>
  Promise.resolve({
    content: [],
    structuredContent: { color: "#abcd" },
  }),
)

await server.connect(new StdioServerTransport())
