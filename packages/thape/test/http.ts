export function http(respond: (request: Request) => Response | Promise<Response>) {
  const urls: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond })

  return {
    urls,
    request: (url: string, init: RequestInit) => {
      urls.push(url)

      return fetch(new URL(new URL(url).pathname, server.url), init)
    },
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}
