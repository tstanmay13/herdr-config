#!/usr/bin/env bash
# Install the Herdr app mods. task-worktree-tab is generated from task-worktree
# (same file, last line make("tab")), because app mods cannot import across folders.
set -euo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mods"
dst="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
mkdir -p "$dst/task-worktree" "$dst/task-worktree-tab"
cp "$src/task-worktree/main.js" "$src/task-worktree/mod.json" "$dst/task-worktree/"
sed 's/^export default make("space");$/export default make("tab");/' "$src/task-worktree/main.js" > "$dst/task-worktree-tab/main.js"
printf '%s\n' '{ "place": "none", "title": "New worker tab", "overlay": { "kind": "dialog", "width": 480, "height": 240 } }' > "$dst/task-worktree-tab/mod.json"
echo "Installed task-worktree and task-worktree-tab into $dst"
