#!/usr/bin/env bash
# Create a task worktree for the focused pane's Git repository and open it as a
# herdr worktree workspace (grouped under the repository's workspace).
#
# Same conventions as cmux-config's Cmd-N flow:
#   branch:   <prefix>/<slug>              (git config herdr.branchPrefix, default tanmaysingh)
#   base:     <remote default branch>      (git config herdr.worktreeBase overrides)
#   worktree: ../<repo>-worktrees/<slug>   (git config herdr.worktreeRoot overrides)
#
# Run from a herdr popup ([[keys.command]] type = "popup"), which provides
# HERDR_ACTIVE_PANE_CWD. Also works from any shell: `new-worktree.sh [task name]`.
# HERDR_WORKTREE_DRY_RUN=1 prints the resolved values without creating anything.
set -uo pipefail

finish() {
  # Keep the popup open long enough to read the result.
  if [ -n "${HERDR_ACTIVE_PANE_ID:-}" ] && [ -z "${HERDR_PANE_ID:-}" ]; then
    printf '\nPress Enter to close.'
    IFS= read -r _ || true
  fi
  exit "$1"
}

git_cfg() { git -C "$repo_root" config --get "herdr.$1" 2>/dev/null || git -C "$repo_root" config --get "cmux.$1" 2>/dev/null; }

start_dir="${HERDR_ACTIVE_PANE_CWD:-$PWD}"
repo_root="$(git -C "$start_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'Not inside a Git repository (%s); no worktree was created.\n' "$start_dir"
  finish 1
}

common_dir="$(cd "$repo_root" && cd "$(git rev-parse --git-common-dir)" && pwd -P)" || finish 1
if [ "$(git -C "$repo_root" rev-parse --is-bare-repository 2>/dev/null)" = "true" ]; then
  canonical_root="$common_dir"
else
  canonical_root="${common_dir%/.git}"
fi
repo_name="$(basename "$canonical_root" .git)"

task_name="${*:-}"
if [ -z "$task_name" ]; then
  printf 'Repository: %s\nTask name (for example, ticket-search-timeout): ' "$repo_name"
  IFS= read -r task_name
fi

slug="$(printf '%s' "$task_name" | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-64)"
[ -n "$slug" ] || { printf 'No usable task name; no worktree was created.\n'; finish 1; }

if prefix="$(git_cfg branchPrefix)"; then :; else prefix="tanmaysingh"; fi
prefix="${prefix%/}"
branch="${prefix:+$prefix/}$slug"

configured_root="$(git_cfg worktreeRoot || true)"
case "$configured_root" in
  "") worktree_root="$(dirname "$canonical_root")/${repo_name}-worktrees" ;;
  "~/"*) worktree_root="$HOME/${configured_root#\~/}" ;;
  /*) worktree_root="$configured_root" ;;
  *) worktree_root="$canonical_root/$configured_root" ;;
esac
worktree_path="$worktree_root/$slug"

base_ref="$(git_cfg worktreeBase || true)"
if [ -z "$base_ref" ]; then
  remote="origin"
  git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || remote="$(git -C "$repo_root" remote | sed -n 1p)"
  if [ -n "$remote" ]; then
    base_ref="$(git -C "$repo_root" symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null || true)"
    for b in main master; do
      [ -z "$base_ref" ] && git -C "$repo_root" show-ref --verify --quiet "refs/remotes/$remote/$b" && base_ref="$remote/$b"
    done
  fi
  base_ref="${base_ref:-HEAD}"
fi

git check-ref-format --branch "$branch" >/dev/null 2>&1 || { printf 'Invalid branch name: %s\n' "$branch"; finish 1; }
if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
  printf 'Branch already exists: %s\nNo worktree was created.\n' "$branch"; finish 1
fi
[ -e "$worktree_path" ] && { printf 'Path already exists: %s\nNo worktree was created.\n' "$worktree_path"; finish 1; }

printf '\nRepository: %s\nBranch:     %s\nBase:       %s\nWorktree:   %s\n\n' \
  "$canonical_root" "$branch" "$base_ref" "$worktree_path"
[ "${HERDR_WORKTREE_DRY_RUN:-0}" = 1 ] && { printf 'Dry run: no worktree was created.\n'; finish 0; }

base_remote="${base_ref%%/*}"
if [ "$base_remote" != "$base_ref" ] && git -C "$repo_root" remote get-url "$base_remote" >/dev/null 2>&1; then
  printf 'Refreshing %s...\n' "$base_ref"
  git -C "$repo_root" fetch -q "$base_remote" "${base_ref#*/}" || { printf 'Fetch failed; no worktree was created.\n'; finish 1; }
fi
mkdir -p "$worktree_root" || finish 1

herdr_bin="${HERDR_BIN_PATH:-herdr}"
if [ -n "${HERDR_SOCKET_PATH:-}" ]; then
  # herdr creates the branch, checks it out, and opens a grouped worktree workspace.
  "$herdr_bin" worktree create --cwd "$repo_root" --branch "$branch" --base "$base_ref" \
    --path "$worktree_path" --label "$slug" --focus || finish 1
else
  git -C "$repo_root" worktree add -q -b "$branch" "$worktree_path" "$base_ref" || finish 1
  printf 'Created outside herdr; open it with: herdr worktree open\n'
fi
printf 'Ready: %s\nWorktrees are never deleted automatically.\n' "$worktree_path"
finish 0
