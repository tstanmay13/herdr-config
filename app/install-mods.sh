#!/usr/bin/env bash
# Install the Herdr app customizations: mods, the "tanmay" layout, and the keys they use.
# task-worktree-tab is generated from task-worktree (same file, last line make("tab")),
# because app mods cannot import across folders. Existing keys are kept; ours are merged in.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$app/mods" "$app/layouts"

for m in task-worktree worktree-prune job-panel pokemon-agents; do
  mkdir -p "$app/mods/$m"
  cp "$here/mods/$m/"* "$app/mods/$m/"
done
mkdir -p "$app/mods/task-worktree-tab"
sed 's/^export default make("space");$/export default make("tab");/' "$here/mods/task-worktree/main.js" > "$app/mods/task-worktree-tab/main.js"
printf '%s\n' '{ "place": "none", "title": "New worker tab", "overlay": { "kind": "dialog", "width": 480, "height": 290 } }' > "$app/mods/task-worktree-tab/mod.json"

cp "$here/layouts/tanmay.json" "$app/layouts/tanmay.json"

keys='{"global": {
  "cmd-n": "mod.open:task-worktree", "cmd-shift-n": "space.new",
  "cmd-shift-t": "mod.open:task-worktree-tab", "cmd-alt-k": "mod.open:worktree-prune",
  "cmd-alt-o": "layout.toggle:ops", "alt-shift-p": "pokemon-agents.pick"}}'
if [ -f "$app/keys.json" ]; then
  jq --argjson k "$keys" '. * $k' "$app/keys.json" > "$app/keys.json.tmp" && mv "$app/keys.json.tmp" "$app/keys.json"
else
  printf '%s\n' "$keys" > "$app/keys.json"
fi

if [ -f "$app/settings.json" ]; then
  jq '.sounds.enabled = false' "$app/settings.json" > "$app/settings.json.tmp" && mv "$app/settings.json.tmp" "$app/settings.json"
fi
echo "Installed mods, the tanmay layout and keys into $app. Switch layout: herdr-app do layout.switch --name tanmay"
