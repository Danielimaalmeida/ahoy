#!/usr/bin/env bash
# Shim. The logic moved to bin/tick.js; this keeps the command name, the
# arguments and the exit code exactly as they were. See bin/start.sh for why
# the shims exist.
#
# bin/serve.py runs this one under a pty to stream the router into the browser,
# so `exec` matters here beyond tidiness: the process the UI signals must be the
# router itself, not a shell holding its hand.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tick.js" "$@"
