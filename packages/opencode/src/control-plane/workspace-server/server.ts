import { Hono } from "hono"
import { SessionRoutes } from "../../server/routes/session"
import { WorkspaceServerRoutes } from "./routes"

export namespace WorkspaceServer {
  export function Listen(opts: { hostname: string; port: number }) {
    const sessionMutationRoutes = new Hono()
      .use("*", async (c, next) => {
        if (c.req.method === "GET") return c.notFound()
        await next()
      })
      .route("/", SessionRoutes())

    const app = new Hono().route("/session", sessionMutationRoutes).route("/", WorkspaceServerRoutes())

    return Bun.serve({
      hostname: opts.hostname,
      port: opts.port,
      fetch: app.fetch,
    })
  }
}
