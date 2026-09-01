#!/usr/bin/env bash
# Shim. The logic moved to bin/start.js; this keeps the command name, the
# arguments and the exit code exactly as they were.
#
# It exists because bin/serve.py and the web UI invoke these scripts by path
# (ROOT/"bin"/"start.sh"), and because every runbook, cron entry and habit in
# the team names the .sh. Removing the name would have made the port a change
# to every caller as well as to the harness. `exec` means there is no extra
# process in the tree and no exit code to translate.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start.js" "$@"
