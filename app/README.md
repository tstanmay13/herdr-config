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
| Cmd-Alt-O | Show or hide the job panel |

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
- `job-panel`: one row per unit of the focused space's orchestrate run (the run whose
  `state.md` names a worktree open in the space; chips pick another). Each row puts the
  orchestrator's claim (verified SHA, status note) next to GitHub now (`gh pr view`: head SHA,
  checks, conflicts, review) and flags mismatches in red: failing checks, conflicts, head is
  not the verified SHA, changes requested. Merged or closed PRs are not flagged. Tabs whose
  branch has a PR but no unit show as "not in state.md"; a space with no run shows just its
  tabs' PRs. The focused tab's unit is highlighted and expanded with every check; click a
  row to expand it, click the PR number to open it. Refreshes on space change, when a
  `state.md` changes, and every 60 s.
  Run chips hide finished runs ("+N finished" shows them): a run is finished when its
  `state.md` has orchestrate's `**Closed:**` line, when every unit's PR is merged or closed,
  or when every PR it opened is merged or closed and `state.md` has been quiet for 3 days
  (units that never got a PR). Merged/closed PR states are cached across restarts.

## Layout

`layouts/tanmay.json` is a clone of the shipped `main` layout (shipped layouts are read-only)
with one added column, `ops`, holding `job-panel`, hidden by default.

## Notes

`herdr-app do tab.new --name 222222` turns the value into a number and fails, while
`--name '"x"'` keeps the quotes literally. Requests with arbitrary names therefore go as one
JSON object: `herdr-app do tab.new '{"name": "222222", ...}'`.
