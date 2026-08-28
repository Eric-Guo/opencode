import { expect, test } from "bun:test"
import { layerPosix, layerWin32 } from "@effect/platform-node/NodePath"
import { Effect } from "effect"
import { DesktopPaths } from "./paths"

test.each(["/workspace/packages/desktop", "/Applications/SigmaAgents.app/Contents/Resources/app.asar"])(
  "resolves desktop assets from the application root %s",
  async (root) => {
    expect(await Effect.runPromise(DesktopPaths.resolve(root).pipe(Effect.provide(layerPosix)))).toEqual({
      developmentResourcesRoot: `${root}/resources`,
      preloadRoot: `${root}/out/preload`,
      preloadPath: `${root}/out/preload/index.js`,
      rendererRoot: `${root}/out/renderer`,
    })
  },
)

test("resolves packaged Windows assets inside the application archive", async () => {
  expect(
    await Effect.runPromise(
      DesktopPaths.resolve("C:\\Program Files\\SigmaAgents\\resources\\app.asar").pipe(Effect.provide(layerWin32)),
    ),
  ).toEqual({
    developmentResourcesRoot: "C:\\Program Files\\SigmaAgents\\resources\\app.asar\\resources",
    preloadRoot: "C:\\Program Files\\SigmaAgents\\resources\\app.asar\\out\\preload",
    preloadPath: "C:\\Program Files\\SigmaAgents\\resources\\app.asar\\out\\preload\\index.js",
    rendererRoot: "C:\\Program Files\\SigmaAgents\\resources\\app.asar\\out\\renderer",
  })
})
