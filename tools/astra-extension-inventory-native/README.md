# Astra native extension inventory reader

This helper is a post-consent, read-only boundary for a future parent Operation.
It accepts no workspace path. The parent must pass an already-open workspace
directory descriptor as file descriptor 3. The helper reads only this fixed
allowlist:

- `opencode.json`
- `opencode.jsonc`
- `.mcp.json`
- `.opencode/opencode.json`
- `.opencode/opencode.jsonc`
- regular files directly inside `.opencode/plugin`
- regular files directly inside `.opencode/plugins`

All lookup after FD 3 is descriptor-relative. Symbolic links, non-regular
entries, files with more than one hard link, identity or metadata drift,
duplicate file identities, oversized input, and malformed names fail closed.
The limits are 64 files, 256 KiB per file, 1 MiB total input, and 2 MiB output.

The helper never parses JSON or JSONC and never executes or imports discovered
content. It performs no network, authentication, subprocess, or filesystem
write operation. Raw bytes exist only in the private parent pipe. They must
never be copied into logs or the operation ledger.

FD 3 must be read-only and stdout must be the unnamed `AF_UNIX` stream
socketpair used by Bun on macOS. Named FIFOs, named Unix sockets, IP sockets,
and regular files are rejected, so the helper cannot direct raw bytes to a
filesystem or network destination.

## Wire protocol: `ASTRXI01`

All integers are unsigned big-endian. Output is canonical: records are sorted
by bytewise relative path and the helper buffers and validates the complete
message before writing stdout.

```text
magic[8] = "ASTRXI01"
record_count: u32
repeat record_count times:
  relative_path_length: u16
  relative_path: UTF-8 bytes
  device: u64
  inode: u64
  mode: u64
  link_count: u64
  size: u64
  sha256: byte[32]
  content_length: u32
  content: byte[content_length]
```

No public product claim is encoded here. The future parent parser is responsible
for producing a redacted inventory whose extensions remain `inactive` and
`not_verified` until a separately governed activation Operation succeeds.

## Reproducible local build

```sh
./build.sh
```

The script uses `/usr/bin/xcrun --find clang`, a fixed locale, fixed flags, and
does not download dependencies. The output is `build/astra-extension-inventory`.

Run the hostile suite under AddressSanitizer and UndefinedBehaviorSanitizer
without retaining an artifact:

```sh
./sanitizer-test.sh
```
