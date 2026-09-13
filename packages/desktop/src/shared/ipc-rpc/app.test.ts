import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AppAwaitInitialization, AppGetCybrosCurrentUser } from "./app"

test("initialization keeps extension metadata across the host RPC boundary", () => {
  const data = {
    url: "http://127.0.0.1:4096",
    localAgent: "7777",
    welcomeText: "Welcome",
    suggestedQuestions: ["Question"],
    ssoJwtSecretKey: "fixture-token",
  }
  expect(Schema.encodeSync(AppAwaitInitialization.successSchema)(data)).toEqual(data)
  expect(Schema.decodeUnknownSync(AppAwaitInitialization.successSchema)({ url: data.url })).toEqual({ url: data.url })
})

test("legacy account responses remain compatible with existing 7777 clients", () => {
  const user = { chinese_name: "Fixture", clerk_code: "test" }
  expect(Schema.encodeSync(AppGetCybrosCurrentUser.successSchema)(user)).toEqual(user)
  expect(Schema.encodeSync(AppGetCybrosCurrentUser.successSchema)(null)).toBeNull()
})
