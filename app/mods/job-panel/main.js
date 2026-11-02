// Job panel: one row per unit of the focused space's orchestrate run, putting what the
// orchestrator recorded (state.md: verified SHA, status) next to what GitHub says now
// (gh pr view: head SHA, checks, conflicts, review), with mismatches flagged on the row.
//
// Run: the one whose state.md names a worktree open in the focused space, else none (chips pick
// any recent run). PRs: each unit's PR column, else its branch; plus branches of open tabs that
// are not in state.md. With no run, the space's tabs' PRs alone (a single-task space).
// The focused tab's unit is highlighted and expanded; click a row to expand or collapse it.
// Refreshes on space change, when a state.md changes, and every 60 s.

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

async function prView(ref, cwd) {
  const r = await sh("gh", ["pr", "view", ...(ref ? [String(ref)] : []), "--json", FIELDS], cwd);
  if (!r.ok) return { error: /no pull requests found/i.test(r.err) ? null : r.err.split("\n")[0] };
  const pr = JSON.parse(r.out);
  return { pr: { ...pr, checks: checks(pr.statusCheckRollup) } };
}

// ---------- the panel ----------

export default class JobPanel extends View {
  init(_props, cx) {
    this.runs = [];
    this.pinned = null;
    this.space = undefined;
    this.view = undefined; // { run, rows, focusedKey }
    this.open = new Set();
    this.allChecks = new Set(); // rows showing passed checks too
    this.finished = new Map(); // run name -> true | false | null
    this.showFinished = false;
    this.reload(cx, true);
    cx.timer.every(2000, (cx) => {
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

  // withGitHub: false re-reads only state.md and keeps the last GitHub data.
  reload(cx, withGitHub) {
    cx.spawn(async (cx) => {
      const { space, cwds, focusedCwd } = spaceFolders();
      this.space = space;
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

      // Branches open in this space's tabs (any one cwd per worktree is enough).
      const tabBranches = new Map(); // branch -> a cwd on it
      for (const c of cwds) {
        const b = (await sh("git", ["branch", "--show-current"], c)).out;
        if (b && !tabBranches.has(b)) tabBranches.set(b, c);
      }
      const focusedBranch = focusedCwd ? (await sh("git", ["branch", "--show-current"], focusedCwd)).out : "";
      const repoCwd = focusedCwd ?? cwds[0] ?? null;

      // One row per unit, then tabs whose branch no unit names.
      const rows = us.map((u) => ({
        key: `u:${u.unit}`, unit: u, branch: (u.branch ?? "").split(/\s/)[0], number: prNumber(u.pr),
      }));
      for (const [b] of tabBranches) {
        if (!rows.some((r) => r.branch === b)) rows.push({ key: `b:${b}`, unit: null, branch: b, number: null });
      }

      const old = new Map((this.view?.rows ?? []).map((r) => [r.key, r]));
      for (const r of rows) {
        if (!withGitHub && old.has(r.key)) { r.gh = old.get(r.key).gh; continue; }
        if (!repoCwd || (!r.number && !r.branch)) { r.gh = { pr: null, error: null }; continue; }
        r.gh = await prView(r.number ?? r.branch, tabBranches.get(r.branch) ?? repoCwd);
      }
      // Tab rows with no PR are noise (e.g. the orchestrator's own branch).
      const shown = rows.filter((r) => r.unit || r.gh?.pr);
      for (const r of shown) if (r.branch && r.branch === focusedBranch) this.open.add(r.key);

      this.runs = runs;
      if (withGitHub && repoCwd) this.checkFinished(cx, runs.slice(0, 12), repoCwd);
      this.view = { run, rows: shown, focusedBranch, at: new Date() };
      cx.notify();
    });
  }

  // Background: which recent runs are finished (see runFinished). Updates the chips when done.
  checkFinished(cx, runs, repoCwd) {
    if (this.checking) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      const states = loadStates();
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

  // Problems with a row, most important first: [text, severity "bad" | "warn"].
  problems(r) {
    const out = [];
    const pr = r.gh?.pr;
    const vsha = sha(r.unit?.["verified tip"]);
    const tip = sha(r.unit?.["tip"]);
    // A merged or closed PR is history: its old checks and SHAs need no action.
    if (pr && pr.state !== "OPEN") return r.unit ? [] : [["not in state.md", "warn"]];
    if (pr) {
      if (pr.state === "OPEN" && (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")) out.push(["conflicts with base: no PR workflows run", "bad"]);
      const fails = pr.checks.filter((c) => c.result === "fail");
      if (fails.length) out.push([`failing: ${fails.slice(0, 2).map((c) => c.name).join(", ")}${fails.length > 2 ? ` +${fails.length - 2}` : ""}`, "bad"]);
      if (r.unit && vsha && !sameSha(vsha, pr.headRefOid)) out.push([`head ${pr.headRefOid.slice(0, 7)} is not the verified ${vsha.slice(0, 7)}`, "bad"]);
      if (r.unit && tip && !sameSha(tip, pr.headRefOid)) out.push([`state.md tip ${tip.slice(0, 7)} is behind head ${pr.headRefOid.slice(0, 7)}`, "warn"]);
      if (pr.reviewDecision === "CHANGES_REQUESTED") out.push(["changes requested", "bad"]);
    } else if (r.unit && r.number) {
      out.push([r.gh?.error ? `gh: ${r.gh.error}` : `PR #${r.number} not found`, "warn"]);
    }
    if (!r.unit) out.push(["not in state.md", "warn"]);
    return out;
  }

  render() {
    const t = theme();
    const v = this.view;
    const root = v_flex().id("job-panel").size_full().p(12).gap(8).bg(t.surface).text_size(12.5);
    const head = div().text_size(11).text_color(t.dim).child("JOB");
    if (v === undefined) return root.child(head).child(div().text_color(t.muted).child("Loading…"));

    // Hide finished runs unless asked; the run shown here always keeps its chip.
    const hidden = this.runs.filter((x) => this.finished.get(x.name) === true && x.name !== v.run?.name);
    const listed = this.runs.filter((x) => this.showFinished || !hidden.includes(x)).slice(0, this.showFinished ? 12 : 6);
    const chips = listed.map((x, i) =>
      div().id(`run-${i}`).px(6).py(2).rounded(5).text_size(11)
        .bg(x.name === v.run?.name ? t.selected : t.raised)
        .text_color(x.name === v.run?.name ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pinned = this.pinned === x.name ? null : x.name; this.open = new Set(); this.reload(cx, true); })
        .child(`${this.finished.get(x.name) === true ? "✓ " : ""}${short(x.name.replace(/^\d{4}-\d{2}-\d{2}-/, ""), 22)}`));
    if (hidden.length) {
      chips.push(div().id("run-finished").px(6).py(2).rounded(5).text_size(11).text_color(t.dim)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.showFinished = !this.showFinished; cx.notify(); })
        .child(this.showFinished ? "hide finished" : `+${hidden.length} finished`));
    }

    const mark = { fail: ["✕", t.blocked], pending: ["●", t.working], pass: ["✓", t.done], skip: ["–", t.dim] };
    const row = (r, i) => {
      const pr = r.gh?.pr;
      const probs = this.problems(r);
      const isOpen = this.open.has(r.key);
      const focusedRow = Boolean(v.focusedBranch) && r.branch === v.focusedBranch;
      const counts = pr ? pr.checks.reduce((m, c) => ((m[c.result] = (m[c.result] ?? 0) + 1), m), {}) : {};
      const state = !pr ? null : pr.state === "MERGED" ? ["merged", t.done] : pr.state === "CLOSED" ? ["closed", t.muted] : pr.isDraft ? ["draft", t.muted] : ["open", t.working];
      const review = pr && { APPROVED: ["approved", t.done], CHANGES_REQUESTED: ["changes requested", t.blocked], REVIEW_REQUIRED: ["review required", t.muted] }[pr.reviewDecision];
      const vsha = sha(r.unit?.["verified tip"]);
      const who = r.unit ? [r.unit["implementer"] && `impl ${r.unit["implementer"].split(" ")[0]}`, r.unit["verifier"] && `verify ${r.unit["verifier"].split(" ")[0]}`].filter(Boolean).join(" · ") : r.branch;

      return v_flex().id(`row-${i}`).p(8).gap(3).rounded(6)
        .bg(focusedRow ? t.selected : t.background)
        .border(1).border_color(probs.some((p) => p[1] === "bad") ? t.blocked : focusedRow ? t.accent : t.background)
        .on_click((_e, cx) => { this.open.has(r.key) ? this.open.delete(r.key) : this.open.add(r.key); cx.notify(); })
        // Name and PR number
        .child(h_flex().gap(8).justify_between()
          .child(div().truncate().font_semibold().text_color(t.foreground).child(r.unit?.unit || r.branch))
          .when(Boolean(pr), (el) => el.child(
            div().id(`pr-${i}`).text_color(t.accent).hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => { exec("open", [pr.url]); cx.stop_propagation(); })
              .child(`#${pr.number}`))))
        .child(div().truncate().text_size(11).text_color(t.dim).child(who))
        // GitHub now
        .when(Boolean(pr), (el) => el.child(h_flex().gap(8).flex_wrap().text_size(11.5)
          .child(div().text_color(state[1]).child(state[0]))
          .child(div().text_color(t.dim).child(pr.headRefOid.slice(0, 7)))
          .child(div().text_color(counts.fail ? t.blocked : t.muted).child(`${counts.fail ?? 0} ✕ · ${counts.pending ?? 0} ● · ${counts.pass ?? 0} ✓`))
          .when(Boolean(review), (el) => el.child(div().text_color(review[1]).child(review[0])))))
        // The orchestrator's claim
        .when(Boolean(r.unit), (el) => el.child(div().text_size(11.5).text_color(t.muted).whitespace_normal().child(
          `${vsha ? `verified ${vsha.slice(0, 7)}` : "not verified"} — ${short(r.unit.status ?? "", isOpen ? 400 : 110)}`)))
        // Mismatches and failures (an expanded row lists failing checks itself)
        .children(probs.filter(([text]) => !(isOpen && text.startsWith("failing:"))).map(([text, sev], k) => div().id(`p-${i}-${k}`).text_size(11.5).whitespace_normal()
          .text_color(sev === "bad" ? t.blocked : t.muted).child(`⚠ ${text}`)))
        // Expanded: failing and running checks by name; passed and skipped fold into one line
        // (click it to list them too).
        .when(isOpen && Boolean(pr), (el) => {
          const all = this.allChecks.has(r.key);
          const listed = pr.checks.filter((c) => all ? c.result !== "skip" : c.result === "fail" || c.result === "pending");
          const quiet = (counts.pass ?? 0) + (counts.skip ?? 0);
          return el.child(v_flex().gap(2).pt(4)
            .children(listed.map((c, k) =>
              h_flex().id(`c-${i}-${k}`).gap(6).text_size(11.5)
                .child(div().w(12).text_color(mark[c.result][1]).child(mark[c.result][0]))
                .child(div().truncate().text_color(c.result === "fail" ? t.foreground : t.muted).child(c.name))))
            .when(quiet > 0, (el) => el.child(
              div().id(`quiet-${i}`).text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => { all ? this.allChecks.delete(r.key) : this.allChecks.add(r.key); cx.stop_propagation(); cx.notify(); })
                .child(all ? "hide passed checks" : `✓ ${counts.pass ?? 0} passed (show) · ${counts.skip ?? 0} skipped`))));
        });
    };

    return root.child(head)
      .child(div().text_size(11).text_color(t.dim).child(
        this.pinned ? "RECENT RUNS · showing the one you picked (click it again to unpick)"
        : v.run ? "RECENT RUNS · showing the run for this space (click another to view it)"
        : "RECENT RUNS · none matches this space (click one to view it)"))
      .child(h_flex().gap(4).flex_wrap().children(chips))
      .child(div().text_size(11).text_color(t.dim).child(
        v.run ? `${v.run.name} · state.md ${ago(v.run.mtime)} · GitHub ${v.at.toLocaleTimeString()}`
              : `No orchestrate run for this space · GitHub ${v.at.toLocaleTimeString()}`))
      .when(v.rows.length === 0, (el) => el.child(div().text_color(t.muted).child("No PRs for the branches open here.")))
      .child(v_flex().id("rows").flex_1().min_h(0).overflow_y_scrollbar().gap(6).children(v.rows.map(row)));
  }
}
