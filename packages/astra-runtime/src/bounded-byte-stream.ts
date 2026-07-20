/** Drains a byte stream while retaining at most the approved number of bytes. */
export async function readBoundedByteStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onExceeded: () => void,
) {
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let retained = 0
  let exceeded = false
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const chunk = result.value
      const remaining = Math.max(0, limit - retained)
      if (remaining > 0) {
        const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
        chunks.push(kept)
        retained += kept.byteLength
      }
      if (!exceeded && chunk.byteLength > remaining) {
        exceeded = true
        onExceeded()
      }
    }
  } finally {
    reader.releaseLock()
  }

  const output = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}
