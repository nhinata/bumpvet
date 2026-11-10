#!/usr/bin/env bash
# Runs a command so that nothing it prints acts as a workflow command, and
# exits with its exit code. Its output can quote text anyone can write (the
# lockfile, the registry, pull request comments). The runner reads standard
# output and standard error apart, with no order between the two, and stops
# reading commands only between `::stop-commands::` and its token, at the start
# of a line (DESIGN.md, Decisions). So: one stream, a token no one can guess,
# and a line break before the closing token.
set -u
if ! token=$(node -e "console.log(require('crypto').randomUUID())"); then
  echo "bumpvet: Node.js could not run." >&2
  exit 1
fi
echo "::stop-commands::$token"
"$@" 2>&1
code=$?
echo
echo "::$token::"
exit "$code"
