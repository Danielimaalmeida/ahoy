#!/usr/bin/env bash
# Shim. The UI server moved from bin/serve.py to bin/serve.js; this keeps a
# stable command name, arguments and exit code. See bin/start.sh for why the
# shims exist.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/serve.js" "$@"
