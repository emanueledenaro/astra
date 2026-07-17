# Astra sandbox prototype

> [!WARNING]
> This package is preserved experimental work for the hardening phase. It is not wired into the working Astra host-execution path and must not be treated as an accepted security boundary. Independent review still requires bounded termination after kill escalation and complete restoration of parent-directory metadata during cleanup.

`@astra/sandbox` is a macOS backend prototype for one capability-bound create-only write.

The caller must obtain explicit approval before calling `executeApprovedDarwinCreateOnly`. The backend then revalidates the approved Bun executable, creates a private sealed copy, starts it through the Apple-signed `/usr/bin/sandbox-exec`, and removes all private runtime state. It never falls back to host execution.

The current boundary is intentionally narrow:

- macOS only;
- exactly one absent create-only target inside the approved workspace;
- workspace reads and private ephemeral runtime scratch;
- no network, child process, inherited environment, or additional writable path;
- bounded execution time and output.

Seatbelt is deprecated Apple technology. This backend treats a missing, invalid, or rejected Seatbelt environment as a hard denial and does not claim broader isolation than the tested file, process, environment, and network boundaries.
