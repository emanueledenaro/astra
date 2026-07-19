import type { Socket } from "node:net"
import type { GitStageProgress } from "@astra/domain/git-stage-control"
import type { AstraGitStageControlHandler } from "./git-stage-control-handler"

/** Bridges one authenticated Stage-selected request to its session-owned handler. */
export function serveAstraGitStageControlRequest(
  socket: Socket,
  candidate: unknown,
  handler: AstraGitStageControlHandler,
) {
  const dispatch = handler.dispatch(candidate, (progress) => writeProgress(socket, progress))
  if (dispatch.status === "rejected") {
    socket.destroy()
    return Promise.resolve()
  }
  write(socket, { schemaVersion: 1, type: "accepted", requestId: dispatch.requestId })
  return dispatch.terminal.then((result) => {
    if (socket.destroyed) return
    socket.end(encode({ schemaVersion: 1, type: "git-stage.terminal", requestId: dispatch.requestId, result }))
  })
}

function writeProgress(socket: Socket, progress: GitStageProgress) {
  write(socket, { schemaVersion: 1, type: "git-stage.progress", requestId: progress.requestId, progress })
}

function write(socket: Socket, value: Readonly<Record<string, unknown>>) {
  if (!socket.destroyed) socket.write(encode(value))
}

function encode(value: Readonly<Record<string, unknown>>) {
  return `${JSON.stringify(value)}\n`
}
