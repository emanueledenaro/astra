# Astra native Git commit helper

This macOS-only C17 helper is the narrow mutation boundary used to publish a
prepared commit. It never resolves a repository path, runs Git, loads hooks,
or reads configuration. The parent opens and pins every authority-bearing
directory before launch.

## Inherited descriptors

- FD 3: `.git` directory (identity pin; currently validation only)
- FD 4: `.git/objects`
- FD 5: `.git/refs/heads`
- FD 6: `.git/logs/refs/heads` when `HAS_REFLOG` is set
- FD 7: parent-private loose-object quarantine root
- stdin: bounded request pipe
- stdout: bounded result pipe; no object content, actor, message, or path bytes

The executable accepts no arguments. Directory traversal is FD-relative and
uses `openat`, `fstat`, identity comparisons, and `O_NOFOLLOW`. FD 4, FD 5,
and optional FD 6 must match the physical descendants opened from FD 3. Ref
ancestry must already exist and may not contain symlinks.

## Request (`ASTRGC01`)

All integers are unsigned big-endian.

```
magic[8] = "ASTRGC01"
version:u16 = 1
flags:u16                 bit 0 = HAS_REFLOG
object_format:u8          1 = SHA-1, 2 = SHA-256
reserved:u8 = 0
object_count:u16          0..256
branch_length:u16         1..512
actor_length:u16          0..256 (required with HAS_REFLOG)
message_length:u16        0..1024 (required with HAS_REFLOG)
old_oid[oid_length]
new_oid[oid_length]
branch[branch_length]
actor[actor_length]
message[message_length]
object_oid[object_count][oid_length]
```

`oid_length` is 20 for SHA-1 and 32 for SHA-256. Branch components reject
empty, dot, dot-dot, `.lock`, controls, backslash, and repeated separators.
Actor/message reject NUL, CR and LF. The parent closes the request pipe after
the exact frame; trailing or truncated input is rejected before effects.

## Response (`ASTRGR01`)

```
magic[8] = "ASTRGR01"
version:u16 = 1
status:u8
detail:u8
object_format:u8
oid_length:u8
new_oid[oid_length]
```

Status values are `0 NO_EFFECT`, `1 OBJECTS_INSTALLED`, `2 REF_UPDATED`, and
`3 UNCERTAIN`. Detail values distinguish malformed authority/protocol,
unsupported format, corrupt objects, CAS mismatch, lock collision, unsafe
ancestry, pre-effect I/O, orphan installed objects, and publication
uncertainty. A zero process exit only means that this response was emitted;
the status remains the authoritative outcome.

Objects are inflated and hashed before installation. Exact existing objects
are accepted. New objects are copied to an exclusive temporary file, synced,
and atomically linked at their OID name. The helper takes exclusive ref and
reflog lock files, rechecks the old OID, publishes the reflog then the ref, and
returns `UNCERTAIN` for failures after the first publication boundary.
