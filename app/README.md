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
- `job-panel`: a status board for orchestrate runs, one line per unit with one word:
  `needs-you`, `ready`, `ready?`, `working`, `waiting`, `paused`, `merged`. The orchestrator
  writes the word at the start of the unit's `status` cell in `state.md` (orchestrate's
  `tanmay/status-words` branch); older runs get a guess from the text. GitHub decides merged,
  and `ready` shows only when GitHub agrees: the head is the verified SHA, every check passed,
  no conflicts. Otherwise the row says `ready?` and why (head moved, 2 checks red, CI running).
  The top section, "Needs you", lists every needs-you and ready unit across all unfinished runs,
  plus any run's `**Needs you:**` line; click one to jump to its run. Below it is the focused
  space's run (chips pick another; "my open PRs" lists every open PR of mine), with merged and
  closed units folded at the bottom. Click a row for the orchestrator's note and the names of
  red checks; click the PR number to open it.
  Finished runs are hidden ("+N finished" shows them): `**Closed:**` in `state.md`, every
  unit's PR merged or closed, or every PR merged or closed and `state.md` quiet for 3 days.
  Speed: PR data is cached across restarts and each space's last view is kept, so switching
  spaces shows rows at once; they refetch in parallel (merged/closed never refetch). One
  background `gh pr list --author @me` call, every 45 s at most, refreshes all open PRs.

## Layout

`layouts/tanmay.json` is a clone of the shipped `main` layout (shipped layouts are read-only)
with one added column, `ops`, holding `job-panel`, hidden by default.

## Notes

`herdr-app do tab.new --name 222222` turns the value into a number and fails, while
`--name '"x"'` keeps the quotes literally. Requests with arbitrary names therefore go as one
JSON object: `herdr-app do tab.new '{"name": "222222", ...}'`.
