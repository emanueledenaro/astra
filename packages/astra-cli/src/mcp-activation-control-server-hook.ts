import type { Socket } from "node:net"
import type { AstraMcpActivationControlHandler } from "./mcp-activation-control-handler"

export function serveAstraMcpActivationControlRequest(
  socket: Socket,
  candidate: unknown,
  handler: AstraMcpActivationControlHandler,
) {
  const dispatch = handler.dispatch(candidate, (progress) => write(socket, { schemaVersion: 1, type: "mcp-activation.progress", requestId: progress.requestId, progress }))
  if (dispatch.status === "rejected") {
    socket.destroy()
    return Promise.resolve()
  }
  write(socket, { schemaVersion: 1, type: "accepted", requestId: dispatch.requestId })
  return dispatch.terminal.then((result) => {
    if (!socket.destroyed) socket.end(encode({ schemaVersion: 1, type: "mcp-activation.terminal", requestId: dispatch.requestId, result }))
  })
}

function write(socket: Socket, value: Readonly<Record<string, unknown>>) {
  if (!socket.destroyed) socket.write(encode(value))
}

function encode(value: Readonly<Record<string, unknown>>) {
  return `${JSON.stringify(value)}\n`
}
