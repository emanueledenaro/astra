import type { Socket } from "node:net"
import type { AstraExtensionInventoryControlHandler } from "./extension-inventory-control-handler"

export function serveAstraExtensionInventoryControlRequest(
  socket: Socket,
  candidate: unknown,
  handler: AstraExtensionInventoryControlHandler,
) {
  const dispatch = handler.dispatch(candidate)
  if (dispatch.status === "rejected") {
    socket.destroy()
    return Promise.resolve()
  }
  write(socket, { schemaVersion: 1, type: "accepted", requestId: dispatch.requestId })
  return dispatch.terminal.then((result) => {
    if (socket.destroyed) return
    socket.end(encode({ schemaVersion: 1, type: "extension-inventory.terminal", requestId: dispatch.requestId, result }))
  })
}

function write(socket: Socket, value: Readonly<Record<string, unknown>>) {
  if (!socket.destroyed) socket.write(encode(value))
}

function encode(value: Readonly<Record<string, unknown>>) {
  return `${JSON.stringify(value)}\n`
}
