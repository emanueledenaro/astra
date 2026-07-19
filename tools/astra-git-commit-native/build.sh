#!/bin/sh
set -eu

export LC_ALL=C
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLANG=$(/usr/bin/xcrun --find clang)
SDK=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)

/bin/mkdir -p "$SCRIPT_DIR/build"
"$CLANG" \
  -std=c17 -O2 -Wall -Wextra -Werror -Wconversion -Wsign-conversion \
  -fno-common -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
  -isysroot "$SDK" "$SCRIPT_DIR/src/main.c" -lz \
  -o "$SCRIPT_DIR/build/astra-git-commit"

