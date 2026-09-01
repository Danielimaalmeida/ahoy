#!/usr/bin/env bash
# Shim. The logic moved to bin/run.js; this keeps the command name, the
# arguments and the exit code exactly as they were. See bin/start.sh for why
# the shims exist.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run.js" "$@"
