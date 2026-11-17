// node app/tests/for-you.test.mjs — the job panel's "For you" items, de-duplication and notices.
import assert from "node:assert/strict";
import { forYouItems, newItems, notice } from "../mods/job-panel/forYou.js";
import { tables, runAsk, strictWord, prNumber } from "../mods/job-panel/state.js";

const md = (u1, u2, ask = "") => `# State
${ask ? `**Needs you:** ${ask}\n` : ""}
## Units
| unit | stage | status | PR | branch |
|---|---|---|---|---|
| 01 snapshot | merge | ${u1} | [#17468](https://github.com/o/r/pull/17468) | a |
| 02 gate | verify | ${u2} | #17507 | b |
| 03 old | build | merge gate met earlier | | c |

## Workers
| worker | role | session | worktree | units | status |
|---|---|---|---|---|---|
| r-05 | implementer | | | 05 | needs-you: paste launch line |
| r-06 | implementer | subagent | | 06 | working: build |
`;
const items = (text) => { const t = tables(text); return forYouItems("2026-11-17-r", { ...t, ask: runAsk(text) }, strictWord, prNumber); };

// Items: ready first; strict words only (the legacy "merge gate met" row is not an item).
let a = items(md("ready: green, 0 threads", "needs-you: pick copy", "approve the plan"));
assert.deepEqual(a.map((x) => x.key), ["u:01:ready", "u:02:needs-you", "w:r-05:needs-you", "ask:needs-you"]);
assert.equal(a[0].pr, "17468");
assert.equal(a[0].url, "https://github.com/o/r/pull/17468");
assert.equal(a[0].ask, "green, 0 threads");
assert.equal(a[2].unit, "r-05", "worker names keep their own name when the run prefix differs");

// First start: baseline, nothing fires.
let { fresh, next } = newItems(undefined, { "2026-11-17-r": a });
assert.deepEqual(fresh, {});
// Same items, a changed note: nothing fires.
const b = items(md("ready: green, 2 approvals", "needs-you: pick copy now", "approve the plan v2"));
({ fresh, next } = newItems(next, { "2026-11-17-r": b }));
assert.deepEqual(fresh, {});
// 02 goes ready: one new item (u:02:ready); the needs-you on 02 is gone.
const c = items(md("ready: green", "ready: verified", "approve the plan"));
({ fresh, next } = newItems(next, { "2026-11-17-r": c }));
assert.deepEqual(fresh["2026-11-17-r"].map((x) => x.key), ["u:02:ready"]);
// Two new items in one sweep batch into one notice for the run.
const d = items(md("ready: green", "ready: verified", "approve the plan").replace("| r-06 | implementer | subagent | | 06 | working: build |", "| r-06 | implementer | subagent | | 06 | needs-you: which flag? |"));
const e = items(md("needs-you: rebase?", "ready: verified", "approve the plan"));
({ fresh } = newItems(next, { "2026-11-17-r": [...d, ...e.filter((x) => x.key === "u:01:needs-you")] }));
const n = notice("r", fresh["2026-11-17-r"]);
assert.equal(n.title, "r: needs you");
assert.equal(n.body.split("\n").length, 2);
// A run that appears after the baseline fires.
({ fresh } = newItems(next, { "2026-11-17-r": c, "2026-11-18-s": items(md("ready: x", "working: y")) }));
assert.deepEqual(Object.keys(fresh), ["2026-11-18-s"]);
// Its fixture also has worker r-05 needing you: both kinds in one title, ready first.
assert.equal(notice("s", fresh["2026-11-18-s"]).title, "s: ready to send for approval · needs you");
assert.equal(notice("s", fresh["2026-11-18-s"]).body.split("\n")[0], "01 snapshot #17468 — x");
console.log("for-you: all tests passed");
