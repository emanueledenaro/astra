import type { Socket } from "node:net"
import { workSessionControlFrameLimitBytes } from "@astra/domain/work-session-control"
import type { AstraWorkSessionControlHandler } from "./work-session-control-handler"

const drainTimeoutMs = 5_000

/** Serves one request; subscription writes are sequential and backpressure-bound. */
export async function serveAstraWorkSessionControlRequest(
  socket: Socket,
  candidate: unknown,
  handler: AstraWorkSessionControlHandler,
) {
  const dispatch = handler.dispatch(candidate)
  if (dispatch.status === "rejected") {
    socket.destroy()
    return
  }
  const abort = new AbortController()
  socket.once("close", () => abort.abort())
  try {
    await write(socket, { schemaVersion: 1, type: "accepted", requestId: dispatch.requestId })
    const terminal = await dispatch.run(abort.signal, (frame) => write(socket, frame))
    if (!dispatch.subscription && !socket.destroyed) socket.end(encode(terminal))
    if (dispatch.subscription && !abort.signal.aborted && !socket.destroyed) socket.end(encode(terminal))
  } catch {
    if (!socket.destroyed) {
      socket.end(
        encode({
          schemaVersion: 1,
          type: "work-session.terminal",
          requestId: dispatch.requestId,
          status: "blocked",
          reason: "state_unavailable",
        }),
      )
    }
  }
}

async function write(socket: Socket, value: Readonly<Record<string, unknown>>) {
  const encoded = encode(value)
  if (Buffer.byteLength(encoded) > workSessionControlFrameLimitBytes) throw new Error("Work-session frame exceeds limit")
  if (socket.destroyed) throw new Error("Work-session socket is closed")
  if (socket.write(encoded)) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Work-session backpressure timed out")), drainTimeoutMs)
    const drain = () => finish()
    const close = () => finish(new Error("Work-session socket closed under backpressure"))
    function finish(error?: Error) {
      clearTimeout(timeout)
      socket.off("drain", drain)
      socket.off("close", close)
      if (error) reject(error)
      else resolve()
    }
    socket.once("drain", drain)
    socket.once("close", close)
  })
}

function encode(value: Readonly<Record<string, unknown>>) {
  return `${JSON.stringify(value)}\n`
}
