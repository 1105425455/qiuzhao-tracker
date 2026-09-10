#!/bin/zsh
ROOT="${0:A:h}"
NODE=""
for candidate in \
  "$(command -v node 2>/dev/null)" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then NODE="$candidate"; break; fi
done
if [[ -z "$NODE" ]]; then
  print "需要 Node.js 22 或以上版本。"
  exit 1
fi
exec "$NODE" "$ROOT/launch.mjs"
