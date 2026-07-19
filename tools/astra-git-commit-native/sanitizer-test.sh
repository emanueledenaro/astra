#!/bin/sh
set -eu

export LC_ALL=C
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLANG=$(/usr/bin/xcrun --find clang)
SDK=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
TEMP=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/astra-git-commit-native.XXXXXX")
trap '/bin/rm -rf "$TEMP"' EXIT HUP INT TERM

"$CLANG" \
  -std=c17 -O1 -g -Wall -Wextra -Werror -Wconversion -Wsign-conversion \
  -fno-omit-frame-pointer -fsanitize=address,undefined -isysroot "$SDK" \
  "$SCRIPT_DIR/src/main.c" -lz -o "$TEMP/astra-git-commit"
ASTRA_GIT_COMMIT_NATIVE_BINARY="$TEMP/astra-git-commit" \
  bun test "$SCRIPT_DIR/test/git-commit-helper.test.ts"

