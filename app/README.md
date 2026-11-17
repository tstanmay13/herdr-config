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
- `pokemon-agents`: a strip under the terminals where each agent in the focused space is a
  Pokémon. Forked from [mathieucroset/herdr-pokemon-agents](https://github.com/mathieucroset/herdr-pokemon-agents)
  (MIT); on first use it downloads PMD SpriteCollab sprites (CC BY-NC) into
  `~/.config/herdr-app/data/pokemon-agents/` and cuts them with ImageMagick, so no art is in
  this repo. Click a Pokémon to go to its agent; right-click or `alt-shift-p` picks another.
  Ours (`workflow.js`): agents are matched to orchestrate runs by their session name (the
  terminal title, `claude -n <run>-<suffix>`), else by worktree; the first tab's agent is the
  run's lead. XP goes into a box (`box.js`, shared state `pokemon-agents.box`) on the Pokémon
  line, not the session, because implementers are one-off: 3 per merged unit an implementer
  owns (paid even after its session exits, from the session name state.md records), 2 per
  merged unit to the run's lead, 1 per two reviews to a verifier. In an `orchestrate mini` run the
  implementers and verifiers are subagents (Workers `session` = `subagent`), never on screen, so
  the lead's line also takes their pay. Level = 5 + XP; lines evolve
  at Lv 16 and 32. A new agent is handed a line from the box that is not on screen, so it can
  arrive already evolved; a fresh first form only when every boxed line is out. A unit ready to merge puts a `PR #N` pill over its owner and the lead (click opens
  it); a ready PR is checked on GitHub, so a merge shows at once: the owner hops and eats.
  `!` only when the agent is blocked on a question (Herdr's meaning). When its run has items for
  you (`orchestrate.flags`), or a worker's own unit needs you, it stops and waves a "⚑ N for
  you" flag, or "✓ N to approve" when an approval waits (click: go to it). A run that just closed dances.
- `job-panel` "For you" (top of the panel): the human's to-dos across open runs (state.md changed
  in the last 14 days). A run with a `## For you` section (orchestrate 9e8d2e0) counts only its
  `- ` lines, one item each, keyed by the line's text; "Approve…"/"Merge…" lines count as ready
  (green), and each `#NNNN` (or a PR URL in the line) is a link. An empty section means nothing
  for you. Older runs without the heading fall back to rows whose status starts with `ready` or
  `needs-you`, workers that need you, and the `**Needs you:**` line. Ready first.
  Click a row to go to the run's space, the PR number to open the PR. These are not Herdr's
  "Needs you" (an agent blocked on a question); nothing here changes an agent's state. When a
  run gains an item (unit id + status word, so a changed note never re-fires), one silent
  in-app notification per run batches its new items; click it to go to the run's space. The
  first start takes a baseline and fires nothing. `herdr-app do job-panel.replay` posts the
  newest run's items again. Logic: `forYou.js` and `state.js`; tests:
  `node app/tests/for-you.test.mjs`; live dry run (reads only): `node app/tests/for-you-dry-run.mjs`.
  The panel also publishes shared `orchestrate.flags` ({ agent address: { run, ready, need } }
  for each run's orchestrator: the first agent tab of the run's space, found by `<run>-<role>`
  titles, worktrees, then a space or agent title naming the run, for mini runs).
- `agents-tanmay`: Herdr's Agents list, cloned from `agents` 0.1.14 (`mod.clone`), used by the
  tanmay layout instead of `agents`. Ours: an "Orchestrators" section under Pinned with every open
  run's orchestrator (most to-dos first), so they are not lost in Done or Idle; and a pill on an
  orchestrator's row from `orchestrate.flags`. The pill is told apart by text and fill, not hue:
  a filled "✓ N to approve (+M)" when an Approve/Merge item waits, a tinted "⚑ N for you"
  otherwise (the Pokémon flag and the For you list's "✓ to approve" tag match). It is not a status:
  the row stays in its own section, and Herdr's "Needs you" still means blocked on a question.
  A clone gets no upstream updates; to take one, clone again and re-apply the flag lines.
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
  and any worker waiting on you sit above the groups, then "can close:" with the worker sessions
  whose work is finished (the same rule as orchestrate's `scripts/sweep.py`; mini-run subagents are
  left out). Rows with a stray `|` are read the way sweep.py reads them: left half from the left,
  right half (status, PR, last checked) from the right. "Other runs" lists one line per
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
