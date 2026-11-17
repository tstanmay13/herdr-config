// node app/tests/activity.test.mjs — the job panel's Activity feed: state.md snapshots and changes.
import assert from "node:assert/strict";
import { snapshot, changes, record, ago } from "../mods/job-panel/activity.js";
import { tables, orchWord, prNumber, forYouSection } from "../mods/job-panel/state.js";

const md = (rows, todo = null) => `# State
${todo ? `## For you\n${todo.map((t) => `- ${t}`).join("\n")}\n` : ""}
## Units
| unit | stage | status | PR | verified tip |
|---|---|---|---|---|
${rows.join("\n")}
`;
const snap = (text) => snapshot(tables(text).units, forYouSection(text), orchWord, prNumber);

const a = snap(md(["| U3 prod-alerts | verify | working: verifier on it | #18791 | |", "| U5 manifest | build | working: building | #18784 | |"], []));
// First sight of a run: a baseline, no events.
assert.deepEqual(changes(undefined, a, 1), []);
// Same state, only a note changed: no events.
const a2 = snap(md(["| U3 prod-alerts | verify | working: verifier halfway | #18791 | |", "| U5 manifest | build | working: building | #18784 | |"], []));
assert.deepEqual(changes(a, a2, 2), []);
// Verifier passes and U3 goes ready; U5 moves stage; a new unit appears; a to-do is added.
const b = snap(md([
  "| U3 prod-alerts | merge | ready: approval | #18791 | abc1234def |",
  "| U5 manifest | ai-review | working: AI round | #18784 | |",
  "| U7 deploy | build | waiting: after #744 | | |",
], ["Approve and merge #18791 [U3]"]));
const ev = changes(a2, b, 3);
assert.deepEqual(ev.map((e) => [e.kind, e.unit.split(" ")[0], e.text]), [
  ["ready", "U3", "ready to send for approval"],
  ["verified", "U3", "verifier passed abc1234"],
  ["stage", "U5", "moved to ai-review"],
  ["new", "U7", "new unit · waiting: after #744"],
  ["todo", "", "for you: Approve and merge #18791 [U3]"],
]);
assert.equal(ev[0].pr, "18791");
// Merge: U3 merged, its to-do leaves the list.
const c = snap(md([
  "| U3 prod-alerts | done | merged: 1a2b3c4 | #18791 | abc1234def |",
  "| U5 manifest | ai-review | working: AI round | #18784 | |",
  "| U7 deploy | build | waiting: after #744 | | |",
], []));
assert.deepEqual(changes(b, c, 4).map((e) => [e.kind, e.text]), [["merged", "merged"], ["done", "off your list: Approve and merge #18791 [U3]"]]);
// A run without a For you section never makes to-do events.
assert.deepEqual(changes(snap(md(["| U1 x | build | working: y | | |"])), snap(md(["| U1 x | build | working: y | | |"])), 5), []);
// record(): baseline, then appends; keeps the last 40.
let store = record({}, "r", a, 1);
assert.deepEqual(store.r.events, []);
store = record(store, "r", b, 3);
store = record(store, "r", c, 4);
assert.equal(store.r.events.length, 7);
for (let i = 0; i < 30; i++) store = record(store, "r", i % 2 ? b : c, 10 + i);
assert.equal(store.r.events.length, 40);
assert.equal(ago(30_000), "now");
assert.equal(ago(4 * 60_000), "4m");
assert.equal(ago(2 * 3600_000), "2h");
console.log("activity: all tests passed");
