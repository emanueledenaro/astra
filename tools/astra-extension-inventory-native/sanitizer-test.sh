#!/bin/sh
set -eu

export LC_ALL=C
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLANG=$(/usr/bin/xcrun --find clang)
SDK=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
TEMPORARY_DIRECTORY=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/astra-extension-inventory-sanitizer.XXXXXX")
trap '/bin/rm -rf "$TEMPORARY_DIRECTORY"' EXIT HUP INT TERM

"$CLANG" \
  -std=c17 \
  -O1 \
  -g \
  -Wall \
  -Wextra \
  -Werror \
  -Wconversion \
  -Wsign-conversion \
  -fno-omit-frame-pointer \
  -fsanitize=address,undefined \
  -isysroot "$SDK" \
  "$SCRIPT_DIR/src/main.c" \
  -o "$TEMPORARY_DIRECTORY/astra-extension-inventory"

ASTRA_NATIVE_INVENTORY_BINARY="$TEMPORARY_DIRECTORY/astra-extension-inventory" \
  bun test "$SCRIPT_DIR/test/inventory-helper.test.ts"
