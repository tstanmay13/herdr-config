// Job panel: a board of the orchestrate run in the focused space, read from its state.md.
// One row per PR: unit tag, PR title, CI mark, the base PR when stacked, the PR number. Click a
// row to open the PR; the chevron shows the orchestrator's note, owners and red checks.
// Rows are grouped by where the unit is: needs you, ready, then the `stage` column (merge, fix,
// verify, ai-review, self-check, build; older runs: guessed from the note), then waiting.
// "ready" shows only when GitHub agrees (head is the verified SHA, CI green, no conflicts),
// else the row says why. Stacks (gh-stack or hand-made) come from each PR's base branch.
// Below: one line per other run that has something for you. "my open PRs" lists all of mine.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, focused, spaces, panes, exec, home, readTextFile, watchFolder } from "herdr";

const ROOTS = () => [`${home()}/.config/agent-orchestrate/runs`, `${home()}/.claude/orchestrate/runs`];
const FIELDS = "number,title,state,isDraft,url,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,headRefName,baseRefName";

async function sh(cmd, args, cwd) {
  try {
    const r = await exec(cmd, args, cwd ? { cwd } : undefined);
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}

// ---------- orchestrate state ----------

async function listRuns() {
  const runs = [];
  for (const root of ROOTS()) {
    const r = await sh("/bin/sh", ["-c", 'for f in "$0"/*/state.md; do [ -f "$f" ] && stat -f "%m %N" "$f"; done', root]);
    for (const line of r.out.split("\n").filter(Boolean)) {
      const sp = line.indexOf(" ");
      const dir = line.slice(sp + 1).slice(0, -"/state.md".length);
      runs.push({ name: dir.split("/").pop(), dir, mtime: Number(line.slice(0, sp)) });
    }
  }
  return runs.sort((a, b) => b.mtime - a.mtime);
}

// state.md's tables: "## Units" (one row per PR) and "## Workers" (one row per session).
// Older runs keep everything in one unit table, with stack summary rows ("R1-R5 runs stack")
// and session rows ("verifier-2") mixed in: summaries are dropped, sessions become workers.
function tables(md) {
  const lines = md.split("\n");
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const units = [], workers = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = cells(lines[i]).map((h) => h.toLowerCase());
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const c = cells(lines[j]);
      rows.push(Object.fromEntries(header.map((h, k) => [h, c[k] ?? ""])));
    }
    if (header.includes("worker")) workers.push(...rows.map((r) => ({ name: r.worker, role: r.role ?? "", status: r.status ?? "" })));
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
function runAsk(md) {
  const m = /^\*\*Needs you:\*\*\s*(.+)$/m.exec(md);
  const text = m?.[1].trim();
  return text && !/^(nothing|none|no\b|n\/a|-)/i.test(text) ? text : null;
}

// Where a unit is in the gates: the stage column, or (older runs) the first stage the note names.
const STAGES = ["build", "self-check", "ai-review", "verify", "fix", "merge", "real-run", "done"];
function stageOf(u) {
  const s = String(u.stage ?? "").trim().toLowerCase().split(/\s/)[0];
  if (STAGES.includes(s)) return s;
  const note = String(u.status ?? "").toLowerCase();
  const hits = [
    ["self-check", /self-check/], ["ai-review", /ai-review|review round/], ["verify", /verif|recheck/],
    ["fix", /\bfix|rework|\bf\d+\b|\bred\b|finding/], ["build", /build|implement|prompted|dispatch/],
  ].map(([st, re]) => { const m = re.exec(note); return m ? [st, m.index] : null; }).filter(Boolean);
  return hits.sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
}

const isBranch = (b) => /^[\w.\/-]+$/.test(b) && !/^(detached|none|-+|n\/a)$/i.test(b);
function unitRow(u) {
  const b = (u.branch ?? "").split(/[\s,]/)[0];
  return { key: `u:${u.unit}`, unit: u, branch: isBranch(b) ? b : "", number: prNumber(u.pr), stage: stageOf(u) };
}

// "A2 access-write" -> { tag: "A2", name: "access-write" }.
function unitLabel(unit) {
  const m = /^([A-Z0-9][A-Za-z0-9-]{0,5})\s+(.+)$/.exec(unit ?? "");
  return m && /[A-Z0-9]/.test(m[1][0]) ? { tag: m[1], name: m[2] } : { tag: "", name: unit ?? "" };
}

// Children after their base PR, indented: covers gh-stack stacks and hand-made ones alike,
// since both are PRs whose base branch is another PR's head. Keeps the input's root order.
function stackOrder(items) {
  const byHead = new Map();
  for (const x of items) { const h = x.r.gh?.pr?.headRefName; if (h) byHead.set(h, x); }
  const kids = new Map(), roots = [];
  for (const x of items) {
    const parent = byHead.get(x.r.gh?.pr?.baseRefName ?? "");
    if (parent && parent !== x) { if (!kids.has(parent)) kids.set(parent, []); kids.get(parent).push(x); }
    else roots.push(x);
  }
  const out = [], seen = new Set();
  const walk = (x, depth) => {
    if (seen.has(x)) return;
    seen.add(x);
    out.push({ ...x, depth });
    for (const k of kids.get(x) ?? []) walk(k, depth + 1);
  };
  roots.forEach((x) => walk(x, 0));
  items.forEach((x) => walk(x, 0)); // anything left in a cycle
  return out;
}

const sha = (s) => (String(s ?? "").match(/\b[0-9a-f]{7,40}\b/) ?? [""])[0];
const prNumber = (s) => (/\b\d{3,}\b/.exec(String(s ?? "")) ?? [null])[0];
const sameSha = (a, b) => Boolean(a && b) && (a.startsWith(b.slice(0, 7)) || b.startsWith(a.slice(0, 7)));
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ago = (mtime) => {
  const d = Date.now() / 1000 - mtime;
  return d < 90 ? "just now" : d < 3600 ? `${Math.round(d / 60)}m ago` : d < 86400 ? `${Math.round(d / 3600)}h ago` : `${Math.round(d / 86400)}d ago`;
};

// ---------- the focused space ----------

// Folders open in the focused space, and the focused one.
function spaceFolders() {
  const f = focused();
  const s = spaces().find((x) => x.id === f?.space);
  const tabs = new Set((s?.tabs ?? []).map((t) => t.id));
  const cwds = [...new Set(panes().filter((p) => tabs.has(p.tab) && p.cwd).map((p) => p.cwd))];
  return { space: f?.space ?? null, cwds, focusedCwd: f?.cwd ?? null };
}

// ---------- GitHub ----------

function checks(rollup) {
  const order = ["fail", "pending", "pass", "skip"];
  return (rollup ?? []).map((c) => {
    const v = (c.conclusion || c.state || c.status || "").toUpperCase();
    const result =
      ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v) ? "fail"
      : v === "SUCCESS" ? "pass"
      : ["SKIPPED", "NEUTRAL", "STALE"].includes(v) ? "skip"
      : "pending";
    return { name: c.name ?? c.context ?? "check", result };
  }).sort((a, b) => order.indexOf(a.result) - order.indexOf(b.result));
}

// A run is finished when state.md has orchestrate's "**Closed:**" line, or every unit has a
// PR and all of them are merged or closed. Merged/closed states never change, so they are
// remembered across restarts (localStorage); open ones are asked again next time.
// Returns true, false, "partial" (every PR it opened is merged or closed, but some units never
// got a PR: parked or never dispatched), or null (no units, or gh failed).
function loadStates() {
  try { return new Map(JSON.parse(localStorage.getItem("prStates") ?? "[]")); } catch { return new Map(); }
}
function saveStates(m) {
  try { localStorage.setItem("prStates", JSON.stringify([...m].filter(([, v]) => v !== "OPEN"))); } catch {}
}
async function runFinished(text, cwd, states) {
  if (/^\*\*Closed:\*\*/m.test(text)) return true;
  const us = tables(text).units;
  if (!us.length || !cwd) return null;
  let missing = false;
  for (const u of us) {
    const n = prNumber(u.pr);
    if (!n) { missing = true; continue; }
    let st = states.get(n);
    if (!st || st === "OPEN") {
      const r = await sh("gh", ["pr", "view", n, "--json", "state", "-q", ".state"], cwd);
      if (!r.ok) return null;
      st = r.out;
      states.set(n, st);
    }
    if (st === "OPEN") return false;
  }
  return missing ? "partial" : true;
}

// ---------- PR cache ----------
// number -> { pr, at }. Shared by every refresh and saved across restarts, so a space shows its
// PRs at once (possibly a minute old) while fresh data loads. Checks are stored already sorted.
function loadPrCache() {
  try { return new Map(JSON.parse(localStorage.getItem("prCache") ?? "[]")); } catch { return new Map(); }
}
function savePrCache(m) {
  try { localStorage.setItem("prCache", JSON.stringify([...m].sort((x, y) => x[1].at - y[1].at).slice(-150))); } catch {}
}
function slim(pr) {
  const { statusCheckRollup, ...rest } = pr;
  return { ...rest, checks: checks(statusCheckRollup) };
}
const done = (pr) => pr && pr.state !== "OPEN"; // merged/closed never change: no refetch


// ---------- status words ----------

const WORDS = ["needs-you", "ready", "working", "waiting", "paused", "merged", "dropped"];
const RANK = { "needs-you": 0, ready: 1, "ready?": 1, open: 2, working: 2, waiting: 3, paused: 4, dropped: 5, closed: 5, merged: 6 };

// The orchestrator's word for a unit: the leading word of the status cell, or, for runs written
// before the word list existed, a guess from the text. Returns { word, rest }.
function orchWord(status) {
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

// What GitHub says about an open PR: green (mergeable now) and, if not, why not.
function ghReady(pr) {
  const fail = pr.checks.filter((c) => c.result === "fail");
  const pend = pr.checks.filter((c) => c.result === "pending").length;
  const why =
    pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY" ? "conflicts"
    : fail.length ? `${fail.length} check${fail.length > 1 ? "s" : ""} red`
    : pend ? "CI running"
    : pr.isDraft ? "draft"
    : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested"
    : null;
  return { green: !why, why, fail, approval: pr.reviewDecision === "REVIEW_REQUIRED" ? "needs approval" : null };
}

// ---------- the panel ----------

export default class JobPanel extends View {
  init(_props, cx) {
    this.runs = [];
    this.pinned = null;
    this.mode = "job"; // "job": the space's run; "mine": all my open PRs
    this.space = undefined;
    this.view = undefined; // { run, rows, focusedBranch }
    this.spaceViews = new Map(); // space id -> its last view, shown at once on switching back
    this.prs = loadPrCache();
    this.mine = null; // numbers of my open PRs, from the batch call
    this.mineAt = 0;
    this.fetching = 0;
    this.seq = 0;
    this.open = new Set();
    this.finished = new Map(); // run name -> true | false | null
    this.states = loadStates(); // PR number -> MERGED | CLOSED (final states only)
    this.others = []; // [{ run, rows, asks }]: other unfinished runs with something for you
    this.showDone = false;
    this.showFinished = false;
    this.reload(cx, true);
    // A cheap comparison; nothing redraws unless the space or folder really changed.
    cx.timer.every(300, (cx) => {
      const s = focused()?.space ?? null;
      const c = focused()?.cwd ?? null;
      if (s !== this.space) { this.pinned = null; this.open = new Set(); this.reload(cx, true); }
      else if (c !== this.cwd) { this.cwd = c; this.markFocused(cx); }
    });
    cx.timer.every(60000, (cx) => this.reload(cx, true));
    for (const root of ROOTS()) {
      cx.spawn(async (cx) => {
        for (;;) {
          try { await watchFolder(root); } catch { return; }
          this.reload(cx, false);
        }
      });
    }
  }

  // Which row the focused terminal belongs to (by its branch).
  markFocused(cx) {
    cx.spawn(async (cx) => {
      const c = this.cwd;
      const b = c ? (await sh("git", ["branch", "--show-current"], c)).out : "";
      if (this.view) { this.view.focusedBranch = b; if (b) this.open.add(`b:${b}`); }
      cx.notify();
    });
  }

  cached(r) {
    if (r.number) return this.prs.get(String(r.number)) ?? null;
    if (!r.branch) return null;
    let best = null;
    for (const v of this.prs.values()) if (v.pr.headRefName === r.branch && (!best || v.pr.number > best.pr.number)) best = v;
    return best;
  }

  // One PR, by number or branch, into the cache. Returns { pr, at } or { error }.
  async fetchOne(ref, cwd) {
    const r = await sh("gh", ["pr", "view", String(ref), "--json", FIELDS], cwd);
    if (!r.ok) return { pr: null, error: /no pull requests found/i.test(r.err) ? null : r.err.split("\n")[0] };
    const entry = { pr: slim(JSON.parse(r.out)), at: Date.now() };
    this.prs.set(String(entry.pr.number), entry);
    return entry;
  }

  // Unresolved review threads on a PR (one GraphQL call); null when gh fails. Asked only for
  // rows that claim ready: the merge gate needs every thread answered.
  async openThreads(pr, cwd) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(pr.url ?? "");
    if (!m) return null;
    const q = "query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved}}}}}";
    const r = await sh("gh", ["api", "graphql", "-f", `query=${q}`, "-f", `o=${m[1]}`, "-f", `n=${m[2]}`, "-F", `p=${m[3]}`,
      "-q", "[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length"], cwd);
    return r.ok ? Number(r.out) : null;
  }

  // Every open PR of mine in one call (about 6 s for 14 PRs), at most every 45 s, in the background.
  refreshMine(cx, cwd) {
    if (this.mineBusy || !cwd || Date.now() - this.mineAt < 45000) return;
    this.mineBusy = true;
    this.fetching++;
    cx.spawn(async (cx) => {
      const r = await sh("gh", ["pr", "list", "--author", "@me", "--state", "open", "--limit", "100", "--json", FIELDS], cwd);
      if (r.ok) {
        const now = Date.now();
        const list = JSON.parse(r.out).map(slim);
        for (const pr of list) {
          // Keep a thread count fetched for the same head; the list call does not carry it.
          const old = this.prs.get(String(pr.number))?.pr;
          if (old?.openThreads != null && old.headRefOid === pr.headRefOid) pr.openThreads = old.openThreads;
          this.prs.set(String(pr.number), { pr, at: now });
        }
        this.mine = list.map((pr) => String(pr.number));
        this.mineAt = now;
        savePrCache(this.prs);
        for (const row of this.view?.rows ?? []) { const c = this.cached(row); if (c) row.gh = c; }
      }
      this.mineBusy = false;
      this.fetching--;
      cx.notify();
    });
  }

  // withGitHub: false re-reads only state.md and keeps the cached GitHub data.
  reload(cx, withGitHub) {
    const seq = ++this.seq;
    cx.spawn(async (cx) => {
      const { space, cwds, focusedCwd } = spaceFolders();
      // Switching spaces: show what this space looked like last time, right away.
      if (space !== this.space) {
        this.space = space;
        this.view = this.spaceViews.get(space) ?? this.view;
        cx.notify();
      }
      this.cwd = focusedCwd;
      const runs = await listRuns();
      // Match runs by task worktrees only ("<repo>-worktrees/<name>"): the main checkout's
      // path appears in nearly every state.md, so it would match whichever run came first.
      const keys = [...new Set(cwds.map((c) => c.split("/").slice(-2).join("/")))].filter((k) => /-?worktrees\//.test(k));
      const read = async (r) => (await readTextFile(`${r.dir}/state.md`).catch(() => null)) ?? "";
      let run = runs.find((r) => r.name === this.pinned) ?? null;
      if (!run) {
        for (const r of runs.slice(0, 15)) {
          r.text = await read(r);
          if (keys.some((k) => r.text.includes(k))) { run = r; break; }
        }
      }
      const tb = run ? tables(run.text ?? (await read(run))) : { units: [], workers: [] };
      const ask = run ? runAsk(run.text ?? "") : null;

      // Other unfinished runs: what needs you there (state.md only; PR data from the cache).
      const others = [];
      for (const r of runs.slice(0, 12)) {
        if (this.finished.get(r.name) === true || r.name === run?.name) continue;
        r.text = r.text ?? (await read(r));
        const t = tables(r.text);
        const rows = t.units.filter((u) => ["needs-you", "ready"].includes(orchWord(u.status).word)).map(unitRow);
        const asks = [runAsk(r.text), ...t.workers.filter((w) => orchWord(w.status).word === "needs-you")
          .map((w) => `${w.name}: ${orchWord(w.status).rest}`)].filter(Boolean);
        if (rows.length || asks.length) others.push({ run: r, rows, asks });
      }
      this.others = others;

      // Branches open in this space's tabs, all at once (any one cwd per worktree is enough).
      const branchOf = await Promise.all([...cwds, focusedCwd].map(async (c) => (c ? (await sh("git", ["branch", "--show-current"], c)).out : "")));
      const tabBranches = new Map(); // branch -> a cwd on it
      cwds.forEach((c, i) => { if (branchOf[i] && !tabBranches.has(branchOf[i])) tabBranches.set(branchOf[i], c); });
      const focusedBranch = branchOf[branchOf.length - 1];
      const repoCwd = focusedCwd ?? cwds[0] ?? null;
      if (seq !== this.seq) return; // a newer reload started

      // One row per unit, then tabs whose branch no unit names. Cached PR data first.
      const rows = tb.units.map(unitRow);
      // Merge briefs (merge-briefs/<unit id>.md): a brief for the PR's current head means the
      // unit is ready even when the orchestrator has not written that to state.md yet.
      if (run) {
        const ls = await sh("/bin/sh", ["-c", 'for f in "$0"/merge-briefs/*.md; do [ -f "$f" ] && echo "$f"; done', run.dir]);
        const files = new Map(ls.out.split("\n").filter(Boolean).map((f) => [f.split("/").pop().slice(0, -3), f]));
        await Promise.all(rows.map(async (r) => {
          const f = files.get(unitLabel(r.unit.unit).tag);
          if (!f) return;
          const text = (await readTextFile(f).catch(() => null)) ?? "";
          const head = sha((/\bhead\b[^0-9a-f]{0,20}([0-9a-f]{7,40})/i.exec(text) ?? [])[1]);
          if (head) r.brief = head;
        }));
      }
      for (const [b] of tabBranches) if (!rows.some((r) => r.branch === b)) rows.push({ key: `b:${b}`, unit: null, branch: b, number: null });
      for (const r of rows) r.gh = this.cached(r);
      for (const r of rows) if (r.branch && r.branch === focusedBranch) this.open.add(r.key);
      const view = { run, rows, focusedBranch, workers: tb.workers, ask };
      this.runs = runs;
      this.view = view;
      this.spaceViews.set(space, view);
      cx.notify();

      if (!withGitHub || !repoCwd) return;
      this.refreshMine(cx, repoCwd);
      if (repoCwd) this.checkFinished(cx, runs.slice(0, 12), repoCwd);
      // Fresh data for each row in parallel; each row updates as its answer lands.
      // Merged/closed PRs are final, so their cached copy is enough.
      await Promise.all(rows.map(async (r) => {
        if (!r.number && !r.branch) return;
        if (done(r.gh?.pr)) return;
        this.fetching++;
        cx.notify();
        const cwd = tabBranches.get(r.branch) ?? repoCwd;
        r.gh = await this.fetchOne(r.number ?? r.branch, cwd);
        if (r.gh?.pr?.state === "OPEN" && r.unit && (orchWord(r.unit.status).word === "ready" || r.brief)) {
          r.gh.pr.openThreads = await this.openThreads(r.gh.pr, cwd);
        }
        this.fetching--;
        cx.notify();
      }));
      savePrCache(this.prs);
    });
  }

  // Background: which recent runs are finished (see runFinished). Updates the chips when done.
  checkFinished(cx, runs, repoCwd) {
    if (this.checking) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      const states = this.states;
      try {
        for (const r of runs) {
          const text = (await readTextFile(`${r.dir}/state.md`).catch(() => null)) ?? "";
          // A run's PRs live in its own repo: use one of its worktrees if it still exists.
          let cwd = repoCwd;
          for (const m of text.matchAll(/(\/Users\/[^\s|]+-worktrees\/[^\s|]+)/g)) {
            if ((await sh("test", ["-d", m[1]])).ok) { cwd = m[1]; break; }
          }
          // "partial" counts as finished once state.md has been quiet for 3 days: a live run
          // either has an open PR or keeps writing state.md.
          const f = await runFinished(text, cwd, states);
          this.finished.set(r.name, f === "partial" ? (Date.now() / 1000 - r.mtime > 3 * 86400 ? true : null) : f);
        }
      } finally {
        saveStates(states);
        this.checking = false;
      }
      cx.notify();
    });
  }

  // A row's status: { word, note, color }. Merged/closed from GitHub win; "ready" only when
  // GitHub agrees; rows with no unit get their word from GitHub alone. The note is the
  // orchestrator's (for ready?, the reason GitHub disagrees).
  status(r, t) {
    const pr = r.gh?.pr;
    const C = { "needs-you": t.blocked, ready: t.done, "ready?": t.working, open: t.working, working: t.working, waiting: t.muted, paused: t.muted, dropped: t.dim, closed: t.dim, merged: t.dim };
    const out = (word, note = null) => ({ word, note, color: C[word] });
    const final = pr && pr.state !== "OPEN" ? pr.state : this.states.get(String(r.number ?? ""));
    if (final === "MERGED") return out("merged");
    if (final === "CLOSED") return out("closed");
    const gh = pr ? ghReady(pr) : null;
    if (!r.unit) return !gh ? out("open") : gh.green ? out("ready", gh.approval) : out("open", gh.why);
    let { word, rest } = orchWord(r.unit.status);
    let verified = sha(r.unit["verified tip"]);
    // A merge brief for the current head outranks a state.md row that was not updated.
    if (r.brief && pr && sameSha(r.brief, pr.headRefOid) && !["ready", "merged", "dropped"].includes(word)) {
      word = "ready";
      verified = r.brief;
    }
    if (word === "ready") {
      if (!gh) return out("ready?", r.number ? "PR not loaded" : "no PR");
      if (verified && !sameSha(verified, pr.headRefOid)) return out("ready?", "head moved since verify");
      if (pr.openThreads > 0) return out("ready?", `${pr.openThreads} open thread${pr.openThreads > 1 ? "s" : ""}`);
      const stale = verified === r.brief && r.brief ? "merge brief sent; state.md not updated" : null;
      return gh.green ? out("ready", [gh.approval, stale].filter(Boolean).join(" · ") || null) : out("ready?", gh.why);
    }
    return out(word, rest.replace(/^(waiting|paused)\s*/i, "") || null);
  }

  // The board group a run row goes in.
  group(r, st) {
    if (RANK[st.word] >= 5) return "done";
    if (st.word === "needs-you") return "needs you";
    if (st.word === "ready" || st.word === "ready?") return "ready";
    if (st.word === "waiting" || st.word === "paused") return "waiting";
    if (!r.unit) return "other PRs in this space";
    return r.stage && r.stage !== "done" && r.stage !== "real-run" ? r.stage : "working";
  }

  render() {
    const t = theme();
    const v = this.view;
    const root = v_flex().id("job-panel").size_full().p(12).gap(8).bg(t.surface).text_size(12.5);
    const label = (s) => div().text_size(11).text_color(t.dim).child(s);
    if (v === undefined) return root.child(label("JOB")).child(div().text_color(t.muted).child("Loading…"));
    const runName = (name) => short(name.replace(/^\d{4}-\d{2}-\d{2}-/, ""), 22);
    const openUrl = (url) => (_e, cx) => { exec("open", [url]); cx.stop_propagation(); };

    // Open PRs by head branch, to name a stacked PR's base.
    const byHead = new Map();
    for (const { pr } of this.prs.values()) if (pr.state === "OPEN") byHead.set(pr.headRefName, pr);

    // CI at a glance: red count, running, conflicts, or green.
    const ci = (pr) => {
      if (!pr || pr.state !== "OPEN") return null;
      const g = ghReady(pr);
      if (g.why === "conflicts") return { text: "conflict", color: t.blocked };
      if (g.fail.length) return { text: `✗${g.fail.length}`, color: t.blocked };
      if (pr.checks.some((c) => c.result === "pending")) return { text: "●", color: t.working };
      return { text: "✓", color: t.done };
    };

    // One PR per row: unit tag, PR title, CI, base PR if stacked, PR number. Clicking the row
    // opens the PR; the chevron shows the orchestrator's note, owners and red checks.
    const row = (r, id, { word = false, depth = 0 } = {}) => {
      const pr = r.gh?.pr;
      const st = this.status(r, t);
      const isOpen = this.open.has(r.key);
      const branch = r.branch || pr?.headRefName || "";
      const focusedRow = Boolean(v.focusedBranch) && branch === v.focusedBranch;
      const { tag, name } = unitLabel(r.unit?.unit);
      const title = pr?.title || name || branch || `#${r.number}`;
      const base = pr?.state === "OPEN" && depth === 0 ? byHead.get(pr.baseRefName) : null;
      const mark = ci(pr);
      const toggle = (cx) => { this.open.has(r.key) ? this.open.delete(r.key) : this.open.add(r.key); cx.notify(); };
      const who = r.unit ? [r.unit["implementer"] && `impl ${r.unit["implementer"].split(" ")[0]}`, r.unit["verifier"] && `verify ${r.unit["verifier"].split(" ")[0]}`].filter(Boolean).join(" · ") : "";
      const fails = mark ? pr.checks.filter((c) => c.result === "fail").map((c) => c.name) : [];
      const dimmed = RANK[st.word] >= 5;
      return v_flex().id(id).pl(8 + depth * 14).pr(6).py(5).gap(2).rounded(6)
        .bg(focusedRow ? t.selected : t.background)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => (pr?.url ? exec("open", [pr.url]) : toggle(cx)))
        .child(h_flex().gap(6)
          .when(word, (el) => el.child(div().w(56).flex_none().text_size(11).font_semibold().text_color(st.color).child(st.word)))
          .when(depth > 0, (el) => el.child(div().flex_none().text_color(t.dim).child("↳")))
          .when(Boolean(tag), (el) => el.child(div().flex_none().px(4).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(tag)))
          .child(div().flex_1().min_w(0).truncate().text_color(dimmed ? t.muted : t.foreground).child(title))
          .when(Boolean(mark), (el) => el.child(div().flex_none().text_size(11).text_color(mark.color).child(mark.text)))
          .when(Boolean(base), (el) => el.child(div().id(`${id}-base`).flex_none().text_size(11).text_color(t.dim)
            .hover((s) => s.text_color(t.foreground)).on_click(openUrl(base.url)).child(`on #${base.number}`)))
          .when(Boolean(pr ?? r.number), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.accent).child(`#${pr?.number ?? r.number}`)))
          .child(div().id(`${id}-more`).flex_none().w(14).text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { toggle(cx); cx.stop_propagation(); }).child(isOpen ? "▾" : "▸")))
        .when(Boolean(st.note) && !dimmed, (el) => el.child(div().truncate().text_size(11).text_color(t.muted).child(st.note)))
        .when(isOpen, (el) => el.child(v_flex().gap(2).pt(2).text_size(11).text_color(t.muted)
          .when(Boolean(r.unit?.unit) && Boolean(pr?.title), (el) => el.child(div().truncate().text_color(t.dim).child(r.unit.unit)))
          .when(Boolean(r.unit?.status), (el) => el.child(div().whitespace_normal().child(r.unit.status)))
          .when(Boolean(who), (el) => el.child(div().truncate().text_color(t.dim).child(who)))
          .when(Boolean(branch), (el) => el.child(div().truncate().text_color(t.dim).child(branch)))
          .when(fails.length > 0, (el) => el.child(div().whitespace_normal().text_color(t.dim).child(`red: ${fails.join(", ")}`)))));
    };

    const pick = (name) => (cx) => { this.mode = "job"; this.pinned = name; this.open = new Set(); this.reload(cx, true); };

    // Run chips (finished runs hidden unless asked) and the "my open PRs" switch.
    const hidden = this.runs.filter((x) => this.finished.get(x.name) === true && x.name !== v.run?.name);
    const listed = this.runs.filter((x) => this.showFinished || !hidden.includes(x)).slice(0, this.showFinished ? 12 : 6);
    const chip = (id, on, text, click) => div().id(id).px(6).py(2).rounded(5).text_size(11)
      .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => click(cx)).child(text);
    const chips = listed.map((x, i) => chip(`run-${i}`, this.mode === "job" && x.name === v.run?.name,
      `${this.finished.get(x.name) === true ? "✓ " : ""}${runName(x.name)}`,
      (cx) => { this.mode = "job"; this.pinned = this.pinned === x.name ? null : x.name; this.open = new Set(); this.reload(cx, true); }));
    if (hidden.length) chips.push(div().id("run-finished").px(6).py(2).text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.showFinished = !this.showFinished; cx.notify(); })
      .child(this.showFinished ? "hide finished" : `+${hidden.length} finished`));
    chips.push(chip("run-mine", this.mode === "mine", `my open PRs${this.mine ? ` (${this.mine.length})` : ""}`,
      (cx) => { this.mode = this.mode === "mine" ? "job" : "mine"; cx.notify(); }));

    // The rows: one per unit; a tab's branch only if its PR is not already a unit's.
    const unitPrs = new Set(v.rows.filter((r) => r.unit).map((r) => String(r.number ?? r.gh?.pr?.number ?? "")));
    const rows = (this.mode === "mine"
      ? (this.mine ?? []).map((n) => ({ key: `p:${n}`, unit: null, number: n, gh: this.prs.get(n), branch: this.prs.get(n)?.pr.headRefName }))
      : v.rows.filter((r) => r.unit || (r.gh?.pr && !unitPrs.has(String(r.gh.pr.number)))))
      .map((r) => ({ r, st: this.status(r, t) }))
      .map((x) => ({ ...x, w: x.st.word, g: this.mode === "mine" ? null : this.group(x.r, x.st) }));
    const live = rows.filter((x) => RANK[x.w] < 5);
    const done = rows.filter((x) => RANK[x.w] >= 5);
    const needN = live.filter((x) => x.w === "needs-you").length + v.workers.filter((w) => orchWord(w.status).word === "needs-you").length + (v.ask ? 1 : 0);
    const readyN = live.filter((x) => x.w === "ready").length;
    const summary = [needN && `${needN} need you`, readyN && `${readyN} ready`, `${live.length} open`].filter(Boolean).join(" · ");

    const ats = live.map((x) => x.r.gh?.at).filter(Boolean); // merged PRs are never refetched
    const fresh = ats.length ? `GitHub ${ago(Math.min(...ats) / 1000)}` : "GitHub not loaded yet";
    const busy = this.fetching > 0 ? " · updating…" : "";

    // Body: in a run, groups by stage; in "my open PRs", every PR with stacks indented.
    const GROUPS = ["needs you", "ready", "merge", "fix", "verify", "ai-review", "self-check", "build", "working", "waiting", "other PRs in this space"];
    const GC = { "needs you": t.blocked, ready: t.done };
    const body = [];
    if (this.mode === "mine") {
      stackOrder(live.sort((a, b) => RANK[a.w] - RANK[b.w])).forEach((x, i) => body.push(row(x.r, `row-${i}`, { word: true, depth: x.depth })));
    } else {
      // The run's own ask and the workers that need something, above the units.
      if (v.ask) body.push(h_flex().id("run-ask").px(8).py(5).gap(6).rounded(6).bg(t.background)
        .child(div().flex_none().text_size(11).font_semibold().text_color(t.blocked).child("needs you"))
        .child(div().flex_1().min_w(0).whitespace_normal().child(v.ask)));
      const busyW = v.workers.filter((w) => orchWord(w.status).word === "working");
      const otherW = v.workers.filter((w) => !["working", "merged", "dropped"].includes(orchWord(w.status).word));
      for (const [i, w] of otherW.entries()) {
        const { word: ww, rest } = orchWord(w.status);
        body.push(h_flex().id(`worker-${i}`).px(8).gap(6).text_size(11)
          .child(div().flex_none().font_semibold().text_color(ww === "needs-you" ? t.blocked : t.muted).child(ww))
          .child(div().flex_none().text_color(t.foreground).child(w.name))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(rest)));
      }
      if (v.workers.length) body.push(div().px(8).text_size(11).text_color(t.dim)
        .child(`${busyW.length} of ${v.workers.length} sessions working: ${busyW.map((w) => w.name).join(", ")}`).truncate());
      let n = 0;
      for (const g of GROUPS) {
        const items = live.filter((x) => x.g === g);
        if (!items.length) continue;
        body.push(div().px(8).pt(6).text_size(10.5).font_semibold().text_color(GC[g] ?? t.dim).child(`${g.toUpperCase()} (${items.length})`));
        for (const x of stackOrder(items)) body.push(row(x.r, `row-${n++}`, { depth: x.depth }));
      }
    }
    if (rows.length === 0) body.push(div().px(8).text_color(t.muted).child(
      this.mode === "mine" ? (this.mine ? "No open PRs." : "Loading your PRs…") : "No PRs for the branches open here."));
    const realRun = done.filter((x) => x.r.stage === "real-run" || /real-run[^;|]*pending/i.test(x.r.unit?.status ?? "")).length;

    // Other runs: one line each, only when something there needs you or is ready to merge.
    const otherEls = this.mode === "mine" ? [] : this.others.map((o, i) => {
      for (const r of o.rows) r.gh = this.cached(r);
      const words = o.rows.map((r) => this.status(r, t).word);
      const need = o.asks.length + words.filter((w) => w === "needs-you").length;
      const ready = words.filter((w) => w === "ready").length;
      if (!need && !ready) return null;
      const first = o.asks[0] ?? orchWord(o.rows.find((r) => this.status(r, t).word === "needs-you")?.unit.status).rest ?? "";
      return v_flex().id(`other-${i}`).px(8).py(4).rounded(6).bg(t.background).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => pick(o.run.name)(cx))
        .child(h_flex().gap(6)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(runName(o.run.name)))
          .when(need > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(`${need} need you`)))
          .when(ready > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.done).child(`${ready} ready`))))
        .when(Boolean(first), (el) => el.child(div().truncate().text_size(11).text_color(t.muted).child(first)));
    }).filter(Boolean);

    return root
      .child(h_flex().gap(4).flex_wrap().children(chips))
      .child(label(
        this.mode === "mine" ? `MY OPEN PRS · ${live.length} open · ${fresh}${busy}`
        : v.run ? `${runName(v.run.name).toUpperCase()} · ${summary} · ${fresh}${busy}`
        : `NO RUN FOR THIS SPACE · ${fresh}${busy}`))
      .child(v_flex().id("rows").flex_1().min_h(0).overflow_y_scrollbar().gap(3)
        .children(body)
        .when(done.length > 0, (el) => el
          .child(div().id("done-toggle").px(8).py(4).text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.showDone = !this.showDone; cx.notify(); })
            .child(`${this.showDone ? "▾" : "▸"} ${done.length} merged or closed${realRun ? ` · ${realRun} need a real run` : ""}`))
          .when(this.showDone, (el) => el.children(done.map((x, i) => row(x.r, `done-${i}`))))))
      .when(otherEls.length > 0, (el) => el
        .child(div().h(1).bg(t.raised))
        .child(label("OTHER RUNS"))
        .child(v_flex().gap(3).children(otherEls)));
  }
}
