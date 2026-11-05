# Job board grouped by stage (2026-11-05)

Goal: the job panel shows the focused orchestrator's run as a readable board, grouped by
where each PR is in the gates, instead of 17 identical "working" rows.

Decisions (Tanmay, 5 Nov): group by stage; change the orchestrate skill's state.md format
and the panel together, with heuristics for older runs.

## Orchestrate skill (~/Documents/personal/orchestrate, branch tanmay/stage-column)
- [x] state.md: `## Units` table (one row per PR or deliverable) and `## Workers` table
      (one row per session); no stack summary rows
- [x] `stage` column: build, self-check, ai-review, verify, fix, merge, real-run, done
- [x] status note at most ~60 characters; `waiting:` names what it waits on
- [x] remove `**Needs you:**` when nothing is open (never write "nothing open")
- [x] CHANGELOG entry

## Job panel (app/mods/job-panel/main.js, branch tanmay/stage-board)
- [x] read Units/Workers tables; legacy: hide stack summary rows, move session rows to workers
- [x] stage from the column; legacy: inferred from the note text
- [x] focused run first: header, run ask line, workers strip, groups
      (needs you, ready, fix, verify, ai-review, self-check, build, working, waiting), merged folded
- [x] row: name + short note inline + PR number
- [x] other runs: one line each with counts, below the run, click to switch
- [x] ignore "Needs you: nothing/none" lines
- [x] README section updated

## Verify
- [x] parse every run under ~/.config/agent-orchestrate/runs with the panel's parser (node)
      and print the grouped board for wkfl-1085 and beta-readiness
- [ ] look at a large run (wkfl-1085) in the app: CI marks, stack indent, click to open (not done: would switch your focused space)

## Review
- Parser run over all 19 runs: 0 errors. wkfl-1085 groups into fix 3, verify 2, self-check 2,
  ai-review 2, working 2, waiting 2; stack rows gone; verifier-2/3 and V moved to workers.
- Panel hot-reloaded; `herdr-app check` passed, `herdr-app status` errors: [].
- Screenshot of tkt-1831-errors space showed the run ask, grouped rows and the Other runs footer.
