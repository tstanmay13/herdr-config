// "For you": the items across orchestrate runs that want Tanmay's eyes, and which of them are new.
// Not herdr's "Needs you" (an agent blocked on a question): these never block anyone. They mean
// "look at this when you can": a unit ready to send for approval, or a unit, worker or run that
// needs you. Pure functions, no herdr imports, so `node forYou.test.mjs` can test them.

const WORDS = ["ready", "needs-you"];

// Items in one run, ready first. `parsed`: { units, workers, ask } from main.js's tables() and
// runAsk(); `word(status)` -> { word, rest }; `prOf(cell)` -> PR number or null.
// Key = unit id + status word, so a changed note never makes an item new again.
export function forYouItems(run, parsed, word, prOf) {
  // A run with a "## For you" section: only its lines count, each one item. The key is the
  // normalized line (its [unit] tag kept), so the same action never fires twice. "Approve" and
  // "Merge" items count as ready (green); anything else as needs you.
  if (Array.isArray(parsed.forYou)) {
    return parsed.forYou.map((text) => {
      const tag = (/\[([^\]]+)\]\s*$/.exec(text) ?? [])[1] ?? "";
      // "#18791" links; "layerone#744" (another repo) only when the line also gives its URL.
      const links = Object.fromEntries([...text.matchAll(/https:\/\/github\.com\/[^\s)\]]+\/pull\/(\d+)/g)].map((m) => [m[1], m[0]]));
      const prs = [...new Set([...text.matchAll(/(?<![\w\/])#(\d{3,})\b/g)].map((m) => m[1]).concat(Object.keys(links)))];
      return {
        run, key: `f:${text}`, word: /^(approve|merge)\b/i.test(text) ? "ready" : "needs-you",
        unit: tag, pr: prs[0] ?? null, prs, links, url: links[prs[0]] ?? null, ask: text, todo: true,
      };
    }).sort((a, b) => WORDS.indexOf(a.word) - WORDS.indexOf(b.word));
  }
  // An older run without the section: ready / needs-you rows, workers and the Needs you line.
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
  const line = (x) => (x.todo ? short(x.ask, 110)
    : [x.unit || "run", x.pr ? `#${x.pr}` : null].filter(Boolean).join(" ") + (x.ask ? ` — ${short(x.ask, 90)}` : ""));
  const title = items.every((x) => x.todo) ? `${runShort}: ${items.length} for you` : `${runShort}: ${what}`;
  return { title, body: items.map(line).join("\n") };
}

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
