# Herdr app (desktop) customizations

Trial setup for the Herdr desktop app (herdr-core based), kept beside the TUI config.
Not wired into install.sh yet.

- `mods/task-worktree/`: task worktrees with cmux-config's conventions: `tanmaysingh/<slug>`
  from the fetched remote default branch, in `../<repo>-worktrees/<slug>`.
  - Cmd-N: a new **space** for a job (nests under the repo).
  - Cmd-Shift-T: a new **tab** in the current space (a worker or verifier of that job).
  Enter closes the dialog at once; `create.sh` fetches and creates the worktree in the
  background (one at a time per repo, so several can queue), then opens the space or tab.
  Failures post a macOS notification; logs are in `~/.local/state/herdr-task-worktree/`.
  `./install-mods.sh` installs both; `task-worktree-tab` is generated from the same file.
- `~/.config/herdr-app/keys.json` (global section):
  `"cmd-n": "mod.open:task-worktree"`, `"cmd-shift-n": "space.new"`,
  `"cmd-shift-t": "mod.open:task-worktree-tab"`.
