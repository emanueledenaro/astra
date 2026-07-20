import { isAbsolute, join, normalize } from "node:path"
import { CString, dlopen, ptr } from "bun:ffi"

const passwdStructBytes = 72
const passwdDirectoryPointerOffset = 48
const passwdBufferBytes = 64 * 1_024

/** Reads the effective user's account home from macOS libc without consulting HOME. */
export function macOSAccountHomeInternal() {
  if (process.platform !== "darwin") throw new TypeError("The Astra account-home locator requires macOS")
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    geteuid: { args: [], returns: "u32" },
    getpwuid_r: { args: ["u32", "ptr", "ptr", "usize", "ptr"], returns: "i32" },
  })
  try {
    const passwd = Buffer.alloc(passwdStructBytes)
    const storage = Buffer.alloc(passwdBufferBytes)
    const result = Buffer.alloc(8)
    const status = library.symbols.getpwuid_r(
      library.symbols.geteuid(),
      ptr(passwd),
      ptr(storage),
      storage.byteLength,
      ptr(result),
    )
    const resultPointer = Number(result.readBigUInt64LE(0))
    const directoryPointer = Number(passwd.readBigUInt64LE(passwdDirectoryPointerOffset))
    if (status !== 0 || resultPointer === 0 || directoryPointer === 0) {
      throw new TypeError("The effective user's macOS account home is unavailable")
    }
    const home = new CString(directoryPointer as ReturnType<typeof ptr>).toString()
    if (
      !isAbsolute(home) ||
      normalize(home) !== home ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(home)
    ) {
      throw new TypeError("The effective user's macOS account home is not canonical")
    }
    return home
  } finally {
    library.close()
  }
}

export function projectScaffoldStateRootInternal() {
  return join(
    macOSAccountHomeInternal(),
    "Library",
    "Application Support",
    "Astra",
    "Operations",
    "project-scaffold",
  )
}
