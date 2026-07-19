import { expect, test } from "bun:test"
import { connectAstraAnthropicCredential } from "../../src/astra/anthropic-auth-connector"

test("stores a credential without returning or reporting the secret", async () => {
  const secret = "sk-ant-parent-only-fixture"
  const stored: string[] = []
  const reports: unknown[] = []

  const result = await connectAstraAnthropicCredential({
    readSecret: () => Promise.resolve(secret),
    storeAndVerifySecret(value) {
      stored.push(value)
      return Promise.resolve(true)
    },
    report(value) {
      reports.push(value)
    },
  })

  expect(stored).toEqual([secret])
  expect(result).toEqual({ status: "stored", providerID: "anthropic", verification: "exact_readback" })
  expect(reports).toEqual([result])
  expect(JSON.stringify({ result, reports })).not.toContain(secret)
})

test("cancellation performs no credential write", async () => {
  let writes = 0
  const result = await connectAstraAnthropicCredential({
    readSecret: () => Promise.resolve(undefined),
    storeAndVerifySecret() {
      writes++
      return Promise.resolve(true)
    },
    report() {},
  })

  expect(result).toEqual({ status: "cancelled" })
  expect(writes).toBe(0)
})

test("does not claim success when exact credential readback fails", async () => {
  const reports: unknown[] = []
  const connection = connectAstraAnthropicCredential({
    readSecret: () => Promise.resolve("sk-ant-unverified-fixture"),
    storeAndVerifySecret: () => Promise.resolve(false),
    report(value) {
      reports.push(value)
    },
  })

  await expect(connection).rejects.toThrow("could not be verified")
  expect(reports).toEqual([])
})
