#!/usr/bin/env bash
# Check that herdr-config is installed as install.sh leaves it. Exit 1 on any failure.
set -uo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_target="${HERDR_CONFIG_PATH:-$HOME/.config/herdr/config.toml}"
failed=0
ok()   { echo "OK $*"; }
fail() { echo "FAIL $*"; failed=1; }

command -v herdr >/dev/null 2>&1 || { fail "herdr is not installed (brew install herdr)"; exit 1; }
ok "herdr $(herdr --version 2>/dev/null | awk '{print $2}')"

if [ -L "$config_target" ] && [ "$(readlink "$config_target")" = "$repo_dir/herdr/config.toml" ]; then
  ok "$config_target linked"
else
  fail "$config_target is not linked to $repo_dir/herdr/config.toml (run ./install.sh)"
fi

bash -n "$repo_dir/scripts/new-worktree.sh" && ok "worktree helper syntax" || fail "worktree helper syntax"

status="$(herdr integration status 2>/dev/null)"
for agent in claude codex; do
  if printf '%s\n' "$status" | grep -E "^$agent:" | grep -qv 'not installed'; then
    ok "$agent integration"
  else
    fail "$agent integration missing (herdr integration install $agent)"
  fi
done

installed="$(herdr plugin list 2>/dev/null || true)"
while read -r id _; do
  if printf '%s\n' "$installed" | grep -qwF -- "$id"; then
    ok "plugin $id"
  else
    fail "plugin $id not installed (run ./install.sh)"
  fi
done < <(grep -vE '^[[:space:]]*(#|$)' "$repo_dir/plugins.txt")

exit "$failed"
