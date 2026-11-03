// Job panel: a status board for orchestrate runs. One line per unit with one status word:
// needs-you, ready, ready?, working, waiting, paused, merged. The orchestrator writes the word at
// the start of the unit's state.md status cell (older runs: guessed from the text); GitHub
// decides merged, and "ready" shows only when GitHub agrees (head is the verified SHA, CI green,
// no conflicts), else "ready?" with the reason.
//
// Top: "Needs you", every needs-you and ready unit across all unfinished runs (from cached PR
// data, no extra GitHub calls), plus each run's "**Needs you:**" line. Below: the focused
// space's run (or a picked chip), merged units folded at the bottom. Click a row for the
// orchestrator's note and the red checks' names; click the PR number to open it.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, focused, spaces, panes, exec, home, readTextFile, watchFolder } from "herdr";

const ROOTS = () => [`${home()}/.config/agent-orchestrate/runs`, `${home()}/.claude/orchestrate/runs`];
const FIELDS = "number,title,state,isDraft,url,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,headRefName";

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

// The first markdown table whose header has a "unit" column: [{ column: value }].
function units(md) {
  const lines = md.split("\n");
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = cells(lines[i]).map((h) => h.toLowerCase());
    if (!header.includes("unit")) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const c = cells(lines[j]);
      rows.push(Object.fromEntries(header.map((h, k) => [h, c[k] ?? ""])));
    }
    return rows;
  }
  return [];
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
  const us = units(text);
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
    this.inbox = []; // [{ run, unit row }] across unfinished runs
    this.runAsks = []; // [{ run, text }] from **Needs you:** lines
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
        for (const pr of list) this.prs.set(String(pr.number), { pr, at: now });
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
      const us = run ? units(run.text ?? (await read(run))) : [];

      // Needs-you and ready units across unfinished runs (state.md only; PR data from the cache).
      const inbox = [], asks = [];
      for (const r of runs.slice(0, 12)) {
        if (this.finished.get(r.name) === true) continue;
        r.text = r.text ?? (await read(r));
        const ask = /^\*\*Needs you:\*\*\s*(.+)$/m.exec(r.text);
        if (ask) asks.push({ run: r, text: ask[1].trim() });
        for (const u of units(r.text)) {
          const w = orchWord(u.status).word;
          if (w === "needs-you" || w === "ready") inbox.push({ run: r, row: { key: `u:${u.unit}`, unit: u, branch: (u.branch ?? "").split(/\s/)[0], number: prNumber(u.pr) } });
        }
      }
      this.inbox = inbox;
      this.runAsks = asks;

      // Branches open in this space's tabs, all at once (any one cwd per worktree is enough).
      const branchOf = await Promise.all([...cwds, focusedCwd].map(async (c) => (c ? (await sh("git", ["branch", "--show-current"], c)).out : "")));
      const tabBranches = new Map(); // branch -> a cwd on it
      cwds.forEach((c, i) => { if (branchOf[i] && !tabBranches.has(branchOf[i])) tabBranches.set(branchOf[i], c); });
      const focusedBranch = branchOf[branchOf.length - 1];
      const repoCwd = focusedCwd ?? cwds[0] ?? null;
      if (seq !== this.seq) return; // a newer reload started

      // One row per unit, then tabs whose branch no unit names. Cached PR data first.
      const rows = us.map((u) => ({ key: `u:${u.unit}`, unit: u, branch: (u.branch ?? "").split(/\s/)[0], number: prNumber(u.pr) }));
      for (const [b] of tabBranches) if (!rows.some((r) => r.branch === b)) rows.push({ key: `b:${b}`, unit: null, branch: b, number: null });
      for (const r of rows) r.gh = this.cached(r);
      for (const r of rows) if (r.branch && r.branch === focusedBranch) this.open.add(r.key);
      const view = { run, rows, focusedBranch };
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
        r.gh = await this.fetchOne(r.number ?? r.branch, tabBranches.get(r.branch) ?? repoCwd);
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
  // GitHub agrees; rows with no unit get their word from GitHub alone.
  status(r, t) {
    const pr = r.gh?.pr;
    const C = { "needs-you": t.blocked, ready: t.done, "ready?": t.working, open: t.working, working: t.working, waiting: t.muted, paused: t.muted, dropped: t.dim, closed: t.dim, merged: t.dim };
    const out = (word, note = null) => ({ word, note, color: C[word] });
    const final = pr && pr.state !== "OPEN" ? pr.state : this.states.get(String(r.number ?? ""));
    if (final === "MERGED") return out("merged");
    if (final === "CLOSED") return out("closed");
    const gh = pr ? ghReady(pr) : null;
    if (!r.unit) return !gh ? out("open") : gh.green ? out("ready", gh.approval) : out("open", gh.why);
    const { word, rest } = orchWord(r.unit.status);
    if (word === "ready") {
      if (!gh) return out("ready?", r.number ? "PR not loaded" : "no PR");
      const v = sha(r.unit["verified tip"]);
      if (v && !sameSha(v, pr.headRefOid)) return out("ready?", "head moved since verify");
      return gh.green ? out("ready", gh.approval) : out("ready?", gh.why);
    }
    if (word === "needs-you") return out(word, short(rest, 70) || null);
    if (word === "waiting" || word === "paused") return out(word, short(rest.replace(/^(waiting|paused)\s*/i, ""), 50) || null);
    return out(word);
  }

  render() {
    const t = theme();
    const v = this.view;
    const root = v_flex().id("job-panel").size_full().p(12).gap(8).bg(t.surface).text_size(12.5);
    const label = (s) => div().text_size(11).text_color(t.dim).child(s);
    if (v === undefined) return root.child(label("JOB")).child(div().text_color(t.muted).child("Loading…"));
    const runName = (name) => short(name.replace(/^\d{4}-\d{2}-\d{2}-/, ""), 22);

    // One line: status word, name, PR number; a second line only for a short note.
    // Expanded: the orchestrator's own note, who owns it, and the red checks by name.
    const row = (r, id, prefix = null, onClick = null) => {
      const pr = r.gh?.pr;
      const st = this.status(r, t);
      const isOpen = this.open.has(r.key) && !onClick;
      const focusedRow = !prefix && Boolean(v.focusedBranch) && r.branch === v.focusedBranch;
      const name = r.unit?.unit || pr?.title || r.branch || `#${r.number}`;
      const who = r.unit ? [r.unit["implementer"] && `impl ${r.unit["implementer"].split(" ")[0]}`, r.unit["verifier"] && `verify ${r.unit["verifier"].split(" ")[0]}`].filter(Boolean).join(" · ") : r.branch;
      const fails = pr && pr.state === "OPEN" ? pr.checks.filter((c) => c.result === "fail").map((c) => c.name) : [];
      return v_flex().id(id).px(8).py(5).gap(2).rounded(6)
        .bg(focusedRow ? t.selected : t.background)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (onClick) return onClick(cx);
          this.open.has(r.key) ? this.open.delete(r.key) : this.open.add(r.key);
          cx.notify();
        })
        .child(h_flex().gap(8)
          .child(div().w(62).flex_none().text_size(11.5).font_semibold().text_color(st.color).child(st.word))
          .child(div().flex_1().min_w(0).truncate().text_color(st.word === "merged" ? t.muted : t.foreground)
            .child(prefix ? `${prefix} · ${name}` : name))
          .when(Boolean(pr ?? r.number), (el) => el.child(
            div().id(`${id}-pr`).flex_none().text_size(11.5).text_color(t.accent).hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => { if (pr) exec("open", [pr.url]); cx.stop_propagation(); })
              .child(`#${pr?.number ?? r.number}`))))
        .when(Boolean(st.note), (el) => el.child(div().pl(70).truncate().text_size(11).text_color(t.muted).child(st.note)))
        .when(isOpen, (el) => el.child(v_flex().pl(70).gap(2).pt(2).text_size(11).text_color(t.muted)
          .when(Boolean(r.unit?.status), (el) => el.child(div().whitespace_normal().child(r.unit.status)))
          .when(Boolean(who), (el) => el.child(div().truncate().text_color(t.dim).child(who)))
          .when(fails.length > 0, (el) => el.child(div().whitespace_normal().text_color(t.dim).child(`red: ${fails.join(", ")}`)))));
    };

    // Needs you: across all unfinished runs, newest run first.
    for (const x of this.inbox) x.row.gh = this.cached(x.row);
    const inbox = this.inbox.filter((x) => ["needs-you", "ready", "ready?"].includes(this.status(x.row, t).word))
      .sort((a, b) => RANK[this.status(a.row, t).word] - RANK[this.status(b.row, t).word]);
    const pick = (name, key) => (cx) => { this.mode = "job"; this.pinned = name; this.open = new Set(key ? [key] : []); this.reload(cx, true); };
    const inboxEls = [
      ...this.runAsks.map((a, i) => h_flex().id(`ask-${i}`).px(8).py(5).gap(8).rounded(6).bg(t.background).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => pick(a.run.name, null)(cx))
        .child(div().w(62).flex_none().text_size(11.5).font_semibold().text_color(t.blocked).child("needs-you"))
        .child(div().flex_1().min_w(0).whitespace_normal().text_color(t.foreground).child(`${runName(a.run.name)} · ${a.text}`))),
      ...inbox.map((x, i) => row(x.row, `in-${i}`, runName(x.run.name), pick(x.run.name, x.row.key))),
    ];

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

    // The run's rows, by status; merged/closed/dropped folded at the bottom.
    const rows = (this.mode === "mine"
      ? (this.mine ?? []).map((n) => ({ key: `p:${n}`, unit: null, number: n, gh: this.prs.get(n), branch: this.prs.get(n)?.pr.headRefName }))
      : v.rows.filter((r) => r.unit || r.gh?.pr))
      .map((r) => ({ r, w: this.status(r, t).word }))
      .sort((a, b) => RANK[a.w] - RANK[b.w]);
    const live = rows.filter((x) => RANK[x.w] < 5);
    const done = rows.filter((x) => RANK[x.w] >= 5);
    const counts = live.reduce((m, x) => ((m[x.w] = (m[x.w] ?? 0) + 1), m), {});
    const summary = Object.entries(counts).map(([w, n]) => `${n} ${w}`).join(" · ") || "nothing open";

    const ats = rows.map((x) => x.r.gh?.at).filter(Boolean);
    const fresh = ats.length ? `GitHub ${ago(Math.min(...ats) / 1000)}` : "GitHub not loaded yet";
    const busy = this.fetching > 0 ? " · updating…" : "";

    return root
      .child(label(`NEEDS YOU${inboxEls.length ? ` (${inboxEls.length})` : ""} · all running jobs`))
      .child(v_flex().gap(3).children(inboxEls.length ? inboxEls : [div().px(8).text_size(11.5).text_color(t.muted).child("Nothing needs you right now.")]))
      .child(div().h(1).bg(t.raised))
      .child(h_flex().gap(4).flex_wrap().children(chips))
      .child(label(
        this.mode === "mine" ? `MY OPEN PRS · ${summary} · ${fresh}${busy}`
        : v.run ? `${runName(v.run.name).toUpperCase()} · ${summary} · ${fresh}${busy}`
        : `NO RUN FOR THIS SPACE · ${fresh}${busy}`))
      .child(v_flex().id("rows").flex_1().min_h(0).overflow_y_scrollbar().gap(3)
        .when(rows.length === 0, (el) => el.child(div().px(8).text_color(t.muted).child(
          this.mode === "mine" ? (this.mine ? "No open PRs." : "Loading your PRs…") : "No PRs for the branches open here.")))
        .children(live.map((x, i) => row(x.r, `row-${i}`)))
        .when(done.length > 0, (el) => el
          .child(div().id("done-toggle").px(8).py(4).text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.showDone = !this.showDone; cx.notify(); })
            .child(`${this.showDone ? "▾" : "▸"} ${done.length} merged or closed`))
          .when(this.showDone, (el) => el.children(done.map((x, i) => row(x.r, `done-${i}`))))));
  }
}
