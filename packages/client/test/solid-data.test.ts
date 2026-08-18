import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { OpenCode } from "../src/promise"
import { createData, type CreateDataInput } from "../src/solid/data"

test("message pagination does not combine cursor with order", async () => {
  const requests: URL[] = []
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      requests.push(url)
      return Response.json({
        data: [],
        cursor: requests.length === 1 ? { next: "next-page" } : {},
      })
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => undefined,
    listen: () => () => undefined,
  }
  let dispose = () => undefined
  const data = createRoot((cleanup) => {
    dispose = cleanup
    return createData({ api: () => client, directory: "/tmp/project", event })
  })

  try {
    await data.session.message.sync("ses_test")
    await data.session.message.loadMore("ses_test")

    expect(requests.map((url) => url.search)).toEqual([
      "?limit=200&order=desc",
      "?limit=200&cursor=next-page",
    ])
  } finally {
    dispose()
  }
})
