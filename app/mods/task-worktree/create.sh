#!/bin/sh
# Background half of the task-worktree mod: fetch, create the worktree, then open it in Herdr.
# The mod validates first, starts this detached and closes its dialog, so creations queue up.
#
# usage: create.sh <space|tab> <space-id|-> <repo-top> <git-common-dir> <branch> <path> <base> <base-remote|-> <slug>
#
# Creations in the same repo run one at a time (a lock dir in the git common dir), so parallel
# `git worktree add` calls don't collide. Output goes to ~/.local/state/herdr-task-worktree/<slug>.log;
# failures also post a macOS notification. HERDR_APP_BIN overrides the herdr-app binary (tests).
set -u
mode=$1 space=$2 top=$3 common=$4 branch=$5 path=$6 base=$7 remote=$8 slug=$9

log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-task-worktree"
mkdir -p "$log_dir"
log="$log_dir/$slug.log"
exec >"$log" 2>&1
echo "$(date '+%F %T') $mode $branch from $base -> $path"

lock="$common/herdr-task-worktree.lock"
have_lock=0
cleanup() { [ "$have_lock" = 1 ] && rmdir "$lock" 2>/dev/null; }
trap cleanup EXIT

fail() {
  echo "FAILED: $1"
  msg="$(printf '%s' "$1" | tr -d '"\\' | cut -c1-180)"
  osascript -e "display notification \"$msg\" with title \"Worktree $slug failed\" subtitle \"Log: $log\"" >/dev/null 2>&1
  exit 1
}

app="${HERDR_APP_BIN:-}"
[ -n "$app" ] || app="$(command -v herdr-app 2>/dev/null || echo "$HOME/.local/bin/herdr-app")"

# Wait up to 5 minutes for another creation in this repo; a lock older than 10 minutes is stale.
tries=0
until mkdir "$lock" 2>/dev/null; do
  find "$lock" -maxdepth 0 -mmin +10 -exec rmdir {} \; 2>/dev/null
  tries=$((tries + 1))
  [ "$tries" -gt 600 ] && fail "timed out waiting for another worktree in this repo"
  sleep 0.5
done
have_lock=1

if [ "$remote" != "-" ]; then
  echo "fetching $base"
  git -C "$top" fetch --quiet "$remote" "${base#"$remote"/}" || fail "could not fetch $base"
fi
mkdir -p "$(dirname "$path")" || fail "could not create $(dirname "$path")"
git -C "$top" worktree add --quiet -b "$branch" "$path" "$base" || fail "git worktree add failed"
rmdir "$lock" 2>/dev/null
have_lock=0

# herdr-app do parses JSON-looking values (222222, true, null) as JSON, so pass the name as a
# JSON string. The slug is only [a-z0-9-], so wrapping it in quotes is enough.
name_json="\"$slug\""
if [ "$mode" = "tab" ] && [ "$space" != "-" ]; then
  "$app" do tab.new --name "$name_json" --space "$space" --folder "$path" || fail "worktree created at $path, but opening the tab failed"
elif [ "$mode" = "tab" ]; then
  "$app" do tab.new --name "$name_json" --folder "$path" || fail "worktree created at $path, but opening the tab failed"
else
  "$app" do space.new --folder "$path" --tab "$name_json" || fail "worktree created at $path, but opening the space failed"
fi
echo "done"
