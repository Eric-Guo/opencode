import { expect, test } from "bun:test"

import { cliInstallPath } from "./cli-install"

test("stages the Windows CLI under the desktop application version", () => {
  expect(cliInstallPath("C:\\Users\\zhangxiaohui\\AppData\\Roaming\\ai.opencode.desktop", "1.18.10", "win32")).toBe(
    "C:\\Users\\zhangxiaohui\\AppData\\Roaming\\ai.opencode.desktop\\cli\\opencode2-v1.18.10.exe",
  )
})

test("sanitizes prerelease versions used as CLI filenames", () => {
  expect(cliInstallPath("/state", "1.18.10+dev/build", "linux")).toBe("/state/cli/opencode2-v1.18.10-dev-build")
})
