import type { Socket } from "node:net"
import type { WorkspaceSearchProgress } from "@astra/domain/governed-workspace-search-control"
import type { AstraGovernedWorkspaceSearchControlHandler } from "./governed-workspace-search-control-handler"

/** Sends at most one accepted frame and keeps the parent task alive after disconnect. */
export function serveAstraGovernedWorkspaceSearchControlRequest(
  socket: Socket,
  candidate: unknown,
  handler: AstraGovernedWorkspaceSearchControlHandler,
) {
  const dispatch = handler.dispatch(candidate, (progress) => writeProgress(socket, progress))
  if (dispatch.status === "rejected") {
    socket.destroy()
    return Promise.resolve()
  }
  write(socket, { schemaVersion: 1, type: "accepted", requestId: dispatch.requestId })
  return dispatch.terminal.then((result) => {
    if (socket.destroyed) return
    socket.end(encode({ schemaVersion: 1, type: "search.terminal", requestId: dispatch.requestId, result }))
  })
}

function writeProgress(socket: Socket, progress: WorkspaceSearchProgress) {
  write(socket, {
    schemaVersion: 1,
    type: "search.progress",
    requestId: progress.requestId,
    progress,
  })
}

function write(socket: Socket, value: Readonly<Record<string, unknown>>) {
  if (!socket.destroyed) socket.write(encode(value))
}

function encode(value: Readonly<Record<string, unknown>>) {
  return `${JSON.stringify(value)}\n`
}
