// Reading orchestrate's state.md (no herdr or UI imports, so node tests and the dry run can use it).

// A table row's cells; "\|" inside a cell is not a separator.
export const cellsOf = (l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
// A row mapped to its header, as orchestrate's sweep.py does: a row with a missing or extra cell
// (an unescaped "|" in a note) keeps its left half aligned from the left and its right half
// (status, PR, last checked) aligned from the right.
export function align(header, row) {
  if (row.length === header.length) return Object.fromEntries(header.map((h, k) => [h, row[k]]));
  const half = Math.floor(header.length / 2);
  const got = {};
  header.forEach((h, i) => {
    const j = i < half ? i : i - header.length + row.length;
    got[h] = (i < half || j >= half) ? row[j] ?? "" : "";
  });
  return got;
}

// state.md's tables: "## Units" (one row per PR) and "## Workers" (one row per session).
// Older runs keep everything in one unit table, with stack summary rows ("R1-R5 runs stack")
// and session rows ("verifier-2") mixed in: summaries are dropped, sessions become workers.
export function tables(md) {
  const lines = md.split("\n");
  const units = [], workers = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = cellsOf(lines[i]).map((h) => h.toLowerCase());
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) rows.push(align(header, cellsOf(lines[j])));
    if (header.includes("worker")) workers.push(...rows.map((r) => ({ name: r.worker, role: r.role ?? "", status: r.status ?? "", session: r.session ?? "" })));
    else if (header.includes("unit")) units.push(...rows);
    i = j - 1;
  }
  const kept = [];
  for (const u of units) {
    const name = u.unit ?? "";
    if (prNumber(u.pr)) { kept.push(u); continue; }
    if (/\bstack\b/i.test(name) || /\b[A-Z]+\d+\s*-\s*[A-Z]*\d+\b/.test(name)) continue;
    const w = orchWord(u.status).word;
    if (w !== "merged" && w !== "dropped" && (/^verifier\b/i.test(name) || /^detached\b/i.test(u.branch ?? ""))) {
      workers.push({ name, role: /verifier/i.test(name) ? "verifier" : "worker", status: u.status ?? "" });
      continue;
    }
    kept.push(u);
  }
  return { units: kept, workers };
}

// The run-wide "**Needs you:**" line, unless it says nothing is open.
export function runAsk(md) {
  const m = /^\*\*Needs you:\*\*\s*(.+)$/m.exec(md);
  const text = m?.[1].trim();
  return text && !/^(nothing|none|no\b|n\/a|-)/i.test(text) ? text : null;
}

export const prNumber = (s) => (/\b\d{3,}\b/.exec(String(s ?? "")) ?? [null])[0];

// The orchestrator's word for a unit: the leading word of the status cell, or, for runs written
// before the word list existed, a guess from the text. Returns { word, rest }.
export function orchWord(status) {
  const s = String(status ?? "").trim();
  const m = /^(needs-you|ready|working|waiting|paused|merged|dropped)\b\s*[:;,-]?\s*/i.exec(s);
  if (m) return { word: m[1].toLowerCase(), rest: s.slice(m[0].length) };
  const guess =
    /^merged\b/i.test(s) ? "merged"
    : /^(ready\b|merge gate met|ready gate passed)/i.test(s) || /\bmerge gate met\b/i.test(s) ? "ready"
    : /\b(needs (you|tanmay)|ask(ing)? tanmay|decision needed|question for tanmay)\b/i.test(s) ? "needs-you"
    : /^(paused|on hold|hold\b)|\bpaused\b|\bon hold\b/i.test(s) ? "paused"
    : /^(waiting|after\b|blocked on|waits? (for|on))/i.test(s) ? "waiting"
    : /^(dropped|abandoned|closed)\b/i.test(s) ? "dropped"
    : "working";
  return { word: guess, rest: s };
}

// Only a status that starts with the word counts for "For you" (no guessing from older notes).
export function strictWord(status) {
  const s = String(status ?? "").trim();
  const m = /^(needs-you|ready)\b\s*[:;,-]?\s*/i.exec(s);
  return m ? { word: m[1].toLowerCase(), rest: s.slice(m[0].length) } : { word: "", rest: s };
}

