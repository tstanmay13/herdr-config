# Job board grouped by stage (2026-11-05)

Goal: the job panel shows the focused orchestrator's run as a readable board, grouped by
where each PR is in the gates, instead of 17 identical "working" rows.

Decisions (Tanmay, 5 Nov): group by stage; change the orchestrate skill's state.md format
and the panel together, with heuristics for older runs.

## Orchestrate skill (~/Documents/personal/orchestrate, branch tanmay/stage-column)
- [ ] state.md: `## Units` table (one row per PR or deliverable) and `## Workers` table
      (one row per session); no stack summary rows
- [ ] `stage` column: build, self-check, ai-review, verify, fix, merge, real-run, done
- [ ] status note at most ~60 characters; `waiting:` names what it waits on
- [ ] remove `**Needs you:**` when nothing is open (never write "nothing open")
- [ ] CHANGELOG entry

## Job panel (app/mods/job-panel/main.js, branch tanmay/stage-board)
- [ ] read Units/Workers tables; legacy: hide stack summary rows, move session rows to workers
- [ ] stage from the column; legacy: inferred from the note text
- [ ] focused run first: header, run ask line, workers strip, groups
      (needs you, ready, fix, verify, ai-review, self-check, build, working, waiting), merged folded
- [ ] row: name + short note inline + PR number
- [ ] other runs: one line each with counts, below the run, click to switch
- [ ] ignore "Needs you: nothing/none" lines
- [ ] README section updated

## Verify
- [ ] parse every run under ~/.config/agent-orchestrate/runs with the panel's parser (node)
      and print the grouped board for wkfl-1085 and beta-readiness
- [ ] install the mod and look at the panel in the app
