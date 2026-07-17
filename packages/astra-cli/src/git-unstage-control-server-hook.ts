import type { Socket } from "node:net"
import type { GitUnstageProgress } from "@astra/domain/git-unstage-control"
import type { AstraGitUnstageControlHandler } from "./git-unstage-control-handler"

/** Bridges one already-decoded private socket request to the isolated handler.
 * Client disconnect never cancels the parent-owned durable task. */
export function serveAstraGitUnstageControlRequest(
  socket: Socket,
  candidate: unknown,
  handler: AstraGitUnstageControlHandler,
) {
  const dispatch = handler.dispatch(candidate, (progress) => writeProgress(socket, progress))
  if (dispatch.status === "rejected") {
    socket.destroy()
    return Promise.resolve()
  }
  write(socket, { schemaVersion: 1, type: "accepted", requestId: dispatch.requestId })
  return dispatch.terminal.then((result) => {
    if (socket.destroyed) return
    socket.end(encode({ schemaVersion: 1, type: "git-unstage.terminal", requestId: dispatch.requestId, result }))
  })
}

function writeProgress(socket: Socket, progress: GitUnstageProgress) {
  write(socket, {
    schemaVersion: 1,
    type: "git-unstage.progress",
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
