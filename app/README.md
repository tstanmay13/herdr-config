# Herdr app (desktop) customizations

My setup for the Herdr desktop app (built on herdr-core, `hc`). One space per job; the
orchestrator, verifier and workers are tabs in it, each in its own worktree.

```bash
./install-mods.sh                       # mods, the "tanmay" layout, keys, sounds off
herdr-app do layout.switch --name tanmay
```

Not wired into `../install.sh` (the herdr TUI installer) yet.

## Keys

| Key | What it does |
| --- | --- |
| Cmd-N | New job: task worktree + a new space (nested under the repo), `claude` started in it |
| Cmd-Shift-T | New worker: task worktree + a tab in the current space, `claude` started in it |
| Cmd-Shift-N | Blank space, no worktree |
| Cmd-Alt-K | Clean up the focused repo's worktrees |
| Cmd-Alt-O | Show or hide the PR panel and job board |

## Mods

- `task-worktree` (and `task-worktree-tab`, generated from the same file by the installer,
  because app mods cannot import across folders). Same conventions as cmux-config:
  `tanmaysingh/<slug>` from the freshly fetched remote default branch, in
  `../<repo>-worktrees/<slug>`. Per-repo `git config herdr.*` (or `cmux.*`) `branchPrefix`,
  `worktreeRoot`, `worktreeBase` override them. Tab moves to an optional first message for
  claude. Enter closes the dialog; `create.sh` does the fetch and checkout in the background
  (one at a time per repo, so several can queue), then opens the tab or space. Failures post a
  macOS notification; logs are in `~/.local/state/herdr-task-worktree/`.
- `worktree-prune`: lists the repo's linked worktrees with PR state (one `gh pr list`),
  uncommitted changes and open tabs. Merged-and-clean ones start selected; ones with
  uncommitted changes cannot be selected. Removing closes the tabs inside, runs
  `git worktree remove` (never `--force`), and deletes the branch only if its PR merged.
- `pr-panel`: the focused tab's PR from `gh pr view`: state, merge state (conflicts mean no
  PR workflows run), review decision, every check by name with failures first. Click the
  title to open it. Refreshes on focus change and every 60 s.
- `job-board`: the orchestrate run for the focused space (the run whose `state.md` names a
  worktree open in it, else the newest), from its units table: PR, status, implementer and
  verifier, and whether the verified SHA matches the tip. Chips switch runs. Refreshes when
  anything under the runs folders changes.

## Layout

`layouts/tanmay.json` is a clone of the shipped `main` layout (shipped layouts are read-only)
with one added column, `ops`, holding `pr-panel` above `job-board`, hidden by default.

## Notes

`herdr-app do tab.new --name 222222` turns the value into a number and fails, while
`--name '"x"'` keeps the quotes literally. Requests with arbitrary names therefore go as one
JSON object: `herdr-app do tab.new '{"name": "222222", ...}'`.
