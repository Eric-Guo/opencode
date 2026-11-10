import { expect, test } from "bun:test"
import { ThapeSso } from "@opencode/thape/sso"
import { ensureSsoUsername, isApiKeyEnvName, ssoHideAgents } from "../src/thape-sso"

test("legacy SSO exports share the Thape implementation and state", () => {
  expect(ensureSsoUsername).toBe(ThapeSso.ensureSsoUsername)
  expect(isApiKeyEnvName).toBe(ThapeSso.isApiKeyEnvName)
  expect(ssoHideAgents).toBe(ThapeSso.ssoHideAgents)
})
