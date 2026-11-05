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
- `job-panel`: a board of the orchestrate run in the focused space, read from its `state.md`
  (orchestrate's `## Units` and `## Workers` tables; older single-table runs drop their stack
  summary rows and move session rows to workers). One row per PR: unit tag, PR title, a CI mark
  (`✗2` red checks, `●` running, `✓` green, `conflict`), `on #N` when the PR is stacked on
  another open PR, and the PR number. Click a row to open the PR, `on #N` to open the base,
  and the chevron for the orchestrator's note, owners, branch and red checks. Rows are grouped:
  needs you, ready, then by the unit's `stage` (merge, fix, verify, ai-review, self-check,
  build; older runs: guessed from the note), then waiting; merged units fold at the bottom
  with a count of those still needing a real run. `ready` shows only when GitHub agrees: the
  head is the verified SHA, every check passed, no conflicts; otherwise the group says why.
  Stacked PRs sit indented under their base, which covers gh-stack stacks and hand-made
  ones, because both are PRs based on another PR's branch. The run's `**Needs you:**` line
  and any worker waiting on you sit above the groups. "Other runs" lists one line per
  unfinished run where something needs you or is ready; click it to switch. Chips pick
  another run; "my open PRs" lists every open PR of mine with stacks indented.
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
