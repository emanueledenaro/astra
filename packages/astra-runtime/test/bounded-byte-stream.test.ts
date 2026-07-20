import { expect, test } from "bun:test"
import { readBoundedByteStream } from "../src/bounded-byte-stream"

test("drains the stream, retains only the bounded prefix, and reports overflow once", async () => {
  let exceeded = 0
  let pulls = 0
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]), new Uint8Array([6])]
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  })

  expect(await readBoundedByteStream(stream, 4, () => exceeded++)).toEqual(new Uint8Array([1, 2, 3, 4]))
  expect(exceeded).toBe(1)
  expect(pulls).toBe(4)
})
