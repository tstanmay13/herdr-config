// "For you": the items across orchestrate runs that want Tanmay's eyes, and which of them are new.
// Not herdr's "Needs you" (an agent blocked on a question): these never block anyone. They mean
// "look at this when you can": a unit ready to send for approval, or a unit, worker or run that
// needs you. Pure functions, no herdr imports, so `node forYou.test.mjs` can test them.

const WORDS = ["ready", "needs-you"];

// Items in one run, ready first. `parsed`: { units, workers, ask } from main.js's tables() and
// runAsk(); `word(status)` -> { word, rest }; `prOf(cell)` -> PR number or null.
// Key = unit id + status word, so a changed note never makes an item new again.
export function forYouItems(run, parsed, word, prOf) {
  const items = [];
  for (const u of parsed.units ?? []) {
    const { word: w, rest } = word(u.status);
    if (!WORDS.includes(w)) continue;
    const name = String(u.unit ?? "").trim();
    const id = name.split(/\s+/)[0] || name;
    items.push({
      run, key: `u:${id}:${w}`, word: w, unit: name, pr: prOf(u.pr), url: urlOf(u.pr),
      ask: rest || (w === "ready" ? "ready to send for approval" : ""),
    });
  }
  for (const wk of parsed.workers ?? []) {
    const { word: w, rest } = word(wk.status);
    if (w !== "needs-you") continue;
    const name = String(wk.name ?? "").replace(`${run}-`, "");
    items.push({ run, key: `w:${wk.name}:${w}`, word: w, unit: name, pr: null, url: null, ask: rest });
  }
  if (parsed.ask) items.push({ run, key: "ask:needs-you", word: "needs-you", unit: "", pr: null, url: null, ask: parsed.ask });
  return items.sort((a, b) => WORDS.indexOf(a.word) - WORDS.indexOf(b.word));
}

// The first URL in a cell such as "[#17468](https://github.com/o/r/pull/17468)".
function urlOf(cell) {
  return (/https?:\/\/[^\s)\]]+/.exec(String(cell ?? "")) ?? [null])[0];
}

// Which items are new since `seen` ({ <run>: [keys] }), and the seen map to store next.
// A run seen for the first time while `seen` is empty (first start of the panel) is a baseline:
// nothing fires. After that a run that appears fires its items. Runs no longer listed keep
// their keys, so a run that drops out of the window does not fire again when it returns.
export function newItems(seen, itemsByRun) {
  const first = !seen || Object.keys(seen).length === 0;
  const next = { ...(seen ?? {}) };
  const fresh = {};
  for (const [run, items] of Object.entries(itemsByRun)) {
    const before = new Set(next[run] ?? []);
    const added = first ? [] : items.filter((x) => !before.has(x.key));
    if (added.length) fresh[run] = added;
    next[run] = items.map((x) => x.key);
  }
  if (first) next["_baseline"] = [];
  return { fresh, next };
}

// One notification for a run's new items: { title, body }.
export function notice(runShort, items) {
  const kinds = [...new Set(items.map((x) => x.word))];
  const what = kinds.map((k) => (k === "ready" ? "ready to send for approval" : "needs you")).join(" · ");
  const line = (x) => [x.unit || "run", x.pr ? `#${x.pr}` : null].filter(Boolean).join(" ") + (x.ask ? ` — ${short(x.ask, 90)}` : "");
  return { title: `${runShort}: ${what}`, body: items.map(line).join("\n") };
}

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
