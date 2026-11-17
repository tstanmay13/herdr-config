// Activity: what changed in a run since the last look, from state.md alone. Each reload takes a
// snapshot of every unit (status word, stage, verified tip) and of the "## For you" lines, and
// compares it with the one before. Pure functions, no herdr imports (node app/tests/activity.test.mjs).

const KEEP = 40; // events kept per run

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sha7 = (s) => (String(s ?? "").match(/\b[0-9a-f]{7,40}\b/) ?? [""])[0].slice(0, 7);

// A run's snapshot: { units: { <id>: { name, word, rest, stage, verified, pr } }, todo: [lines] | null }.
// `units`: tables() rows; `word(status)` -> { word, rest }; `prOf(cell)` -> PR number or null.
export function snapshot(units, todo, word, prOf) {
  const out = {};
  for (const u of units ?? []) {
    const name = String(u.unit ?? "").trim();
    const id = name.split(/\s+/)[0];
    if (!id) continue;
    const { word: w, rest } = word(u.status);
    out[id] = { name, word: w, rest: short(rest ?? "", 70), stage: String(u.stage ?? "").trim().toLowerCase(), verified: sha7(u["verified tip"]), pr: prOf(u.pr) };
  }
  return { units: out, todo: Array.isArray(todo) ? todo : null };
}

const SAY = {
  ready: () => "ready to send for approval",
  merged: () => "merged",
  dropped: () => "dropped",
  "needs-you": (rest) => `needs you${rest ? `: ${rest}` : ""}`,
  waiting: (rest) => `waiting${rest ? `: ${rest}` : ""}`,
  paused: (rest) => `paused${rest ? `: ${rest}` : ""}`,
  working: (rest) => `working${rest ? `: ${rest}` : ""}`,
};

// Events between two snapshots, newest last: [{ at, kind, unit, pr, text }].
// kind: "merged" | "ready" | "needs-you" | "verified" | "stage" | "status" | "new" | "todo" | "done".
// No `before` (a run seen for the first time) gives no events: that is the baseline.
export function changes(before, after, at) {
  if (!before) return [];
  const ev = [];
  const add = (kind, u, text) => ev.push({ at, kind, unit: u?.name ?? "", pr: u?.pr ?? null, text });
  for (const [id, u] of Object.entries(after.units)) {
    const b = before.units?.[id];
    if (!b) { add("new", u, `new unit · ${SAY[u.word]?.(u.rest) ?? u.word}`); continue; }
    if (u.word !== b.word) {
      const kind = ["merged", "ready", "needs-you"].includes(u.word) ? u.word : "status";
      add(kind, u, SAY[u.word]?.(u.rest) ?? (u.word || "status changed"));
    } else if (u.stage && u.stage !== b.stage) {
      add("stage", u, `moved to ${u.stage}`);
    }
    if (u.verified && u.verified !== b.verified) add("verified", u, `verifier passed ${u.verified}`);
  }
  // "## For you" lines: a new line is a to-do; a line that went away was done (or withdrawn).
  if (after.todo && before.todo) {
    const was = new Set(before.todo), now = new Set(after.todo);
    for (const t of after.todo) if (!was.has(t)) ev.push({ at, kind: "todo", unit: "", pr: null, text: `for you: ${t}` });
    for (const t of before.todo) if (!now.has(t)) ev.push({ at, kind: "done", unit: "", pr: null, text: `off your list: ${t}` });
  }
  return ev;
}

// The stored activity after one reload: { snap, events } per run, events capped at KEEP.
export function record(store, run, snap, at) {
  const prev = store?.[run];
  const events = [...(prev?.events ?? []), ...changes(prev?.snap, snap, at)].slice(-KEEP);
  return { ...(store ?? {}), [run]: { snap, events } };
}

// "4m", "2h", "3d".
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
