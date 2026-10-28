#!/bin/sh
# Test runner for `npm test`.
#   npm test                          -> every src/**/*.test.ts
#   npm test -- <flags>               -> every src/**/*.test.ts, with the flags
#   npm test -- path/to/x.test.ts ... -> only the given test files (plus flags)
# It never falls back to node's default discovery, which would pick up stale
# compiled tests in dist/, and it fails when no test file can be found.

has_test_file=0
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *.test.ts) has_test_file=1 ;;
  esac
done

if [ "$has_test_file" -eq 0 ]; then
  files=$(find src -name '*.test.ts' 2>/dev/null | sort)
  if [ -z "$files" ]; then
    echo "error: no *.test.ts files found under src/ (run from the project root)" >&2
    exit 1
  fi
  # Intentionally unquoted: one argument per discovered file.
  # shellcheck disable=SC2086
  set -- "$@" $files
fi

exec tsx --test "$@"
