import type { Socket } from "node:net"
import type { HostCommandProgress } from "@astra/domain/host-command-control"
import type { AstraHostCommandControlHandler } from "./host-command-control-handler"

/** Keeps an accepted parent operation alive if the requesting TUI disconnects. */
export function serveAstraHostCommandControlRequest(
  socket: Socket,
  candidate: unknown,
  handler: AstraHostCommandControlHandler,
) {
  const dispatch = handler.dispatch(candidate, (progress) => writeProgress(socket, progress))
  if (dispatch.status === "rejected") {
    socket.destroy()
    return Promise.resolve()
  }
  write(socket, { schemaVersion: 1, type: "accepted", requestId: dispatch.requestId })
  return dispatch.terminal.then((result) => {
    if (socket.destroyed) return
    socket.end(encode({ schemaVersion: 1, type: "host-command.terminal", requestId: dispatch.requestId, result }))
  })
}

function writeProgress(socket: Socket, progress: HostCommandProgress) {
  write(socket, { schemaVersion: 1, type: "host-command.progress", requestId: progress.requestId, progress })
}

function write(socket: Socket, value: Readonly<Record<string, unknown>>) {
  if (!socket.destroyed) socket.write(encode(value))
}

function encode(value: Readonly<Record<string, unknown>>) {
  return `${JSON.stringify(value)}\n`
}
