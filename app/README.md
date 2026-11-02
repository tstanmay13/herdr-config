# Herdr app (desktop) customizations

Trial setup for the Herdr desktop app (herdr-core based), kept beside the TUI config.
Not wired into install.sh yet.

- `mods/task-worktree/`: Cmd-N task worktree. Copy to `~/.config/herdr-app/mods/`.
  Same conventions as cmux-config: `tanmaysingh/<slug>` from the fetched remote default
  branch, in `../<repo>-worktrees/<slug>`, opened as a new space nested under the repo.
- `~/.config/herdr-app/keys.json` (global section):
  `"cmd-n": "mod.open:task-worktree"`, `"cmd-shift-n": "space.new"`.
