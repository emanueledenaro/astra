import type { Socket } from "node:net"
import type { GitCommitProgress } from "@astra/domain/git-commit-control"
import type { AstraGitCommitControlHandler } from "./git-commit-control-handler"

/** Bridges one authenticated Commit-staged request to its session-owned handler. */
export function serveAstraGitCommitControlRequest(
  socket: Socket,
  candidate: unknown,
  handler: AstraGitCommitControlHandler,
) {
  const dispatch = handler.dispatch(candidate, (progress) => writeProgress(socket, progress))
  if (dispatch.status === "rejected") {
    socket.destroy()
    return Promise.resolve()
  }
  write(socket, { schemaVersion: 1, type: "accepted", requestId: dispatch.requestId })
  return dispatch.terminal.then((result) => {
    if (socket.destroyed) return
    socket.end(encode({ schemaVersion: 1, type: "git-commit.terminal", requestId: dispatch.requestId, result }))
  })
}

function writeProgress(socket: Socket, progress: GitCommitProgress) {
  write(socket, { schemaVersion: 1, type: "git-commit.progress", requestId: progress.requestId, progress })
}

function write(socket: Socket, value: Readonly<Record<string, unknown>>) {
  if (!socket.destroyed) socket.write(encode(value))
}

function encode(value: Readonly<Record<string, unknown>>) {
  return `${JSON.stringify(value)}\n`
}
