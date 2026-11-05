// The orchestrate layer (ours, not upstream's): reads every recent run's state.md and works out,
// for each agent, which run it belongs to, its role there, and what it has earned.
// Workers are launched as `claude -n <run>-<suffix>` ("2026-11-04-wkfl-1085-R", older runs
// "tkt-1831-audit"), and Claude sets the terminal title to that name, so the title says the
// run; state.md's implementer cell names the same session, so it says the units.
//   worker    an implementer: its units are the ones whose implementer cell names it
//   verifier  a session whose name says verifier
//   lead      the orchestrator: the first agent tab of a space whose other agents are the run's
// Fallback for agents with other titles: their worktree is a unit's or a worker's.
// Levels: lead 5 + 2 per merged unit in the run, worker 5 + 3 per merged unit it owns,
// verifier 5 + 1 per two verification reports in the run. Pokémon evolve at Lv 16 and 32.
// Mods cannot import across folders, so the table parsing is a trimmed copy of job-panel's.
import { exec, home, readTextFile } from "herdr";

const ROOTS = () => [`${home()}/.config/agent-orchestrate/runs`, `${home()}/.claude/orchestrate/runs`];
const PARTY_MS = 15 * 60 * 1000; // a run that closed this recently is still celebrating

async function sh(script, arg) {
  try {
    const r = await exec("/bin/sh", ["-c", script, arg]);
    return r.code === 0 ? (r.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

const WORD = /^(needs-you|ready|working|waiting|paused|merged|dropped)\b\s*[:;,-]?\s*/i;
function wordOf(status) {
  const s = String(status ?? "").trim();
  const m = WORD.exec(s);
  if (m) return { word: m[1].toLowerCase(), rest: s.slice(m[0].length) };
  return { word: /^merged\b/i.test(s) ? "merged" : /^(dropped|abandoned|closed)\b/i.test(s) ? "dropped" : "working", rest: s };
}

// "repo-worktrees/wkfl-1085-runs" from a path or a state.md cell; "" when it is not a worktree.
export function worktreeKey(p) {
  const k = String(p ?? "").replace(/\\\//g, "/").trim().split(/\s/)[0].replace(/\/+$/, "").split("/").slice(-2).join("/");
  return /-?worktrees\//.test(k) ? k : "";
}

const prNumber = (s) => (/\b\d{3,}\b/.exec(String(s ?? "")) ?? [null])[0];
// "A2 access-write" -> "A2"; "02-dashboard-monitors (+08)" -> "02".
const tagOf = (unit) => (/^([A-Z0-9][A-Za-z0-9-]{0,5})\s+\S/.exec(unit ?? "") ?? /^(\d{1,3})-/.exec(unit ?? "") ?? [null, unit ?? ""])[1];

// Units and workers from state.md: "## Units" / "## Workers", or one older mixed table.
function parse(md) {
  const lines = md.split("\n");
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const units = [], workers = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = cells(lines[i]).map((h) => h.toLowerCase());
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const c = cells(lines[j]);
      const row = Object.fromEntries(header.map((h, k) => [h, c[k] ?? ""]));
      const { word } = wordOf(row.status);
      if (header.includes("worker")) {
        workers.push({ name: row.worker, role: row.role || (/verifier/i.test(row.worker) ? "verifier" : "worker"), worktree: worktreeKey(row.worktree), session: row.session ?? "", word });
      } else if (header.includes("unit")) {
        const name = row.unit ?? "";
        const pr = prNumber(row.pr);
        if (!pr && (/\bstack\b/i.test(name) || /\b[A-Z]+\d+\s*-\s*[A-Z]*\d+\b/.test(name))) continue; // a stack summary
        if (!pr && word !== "merged" && word !== "dropped" && (/^verifier\b/i.test(name) || /^detached\b/i.test(row.branch ?? ""))) {
          workers.push({ name, role: /verifier/i.test(name) ? "verifier" : "worker", worktree: worktreeKey(row.worktree), session: row.implementer ?? "", word });
          continue;
        }
        units.push({ tag: tagOf(name), name, word, pr, worktree: worktreeKey(row.worktree), impl: row.implementer ?? "" });
      }
    }
    i = j - 1;
  }
  return { units, workers };
}

// A PR that looks ready gets one GitHub check, so a merge shows (and gets eaten) before the
// orchestrator writes it down. Merged and closed are final, so they are asked once.
const finalState = new Map();
async function prState(n, cwd) {
  if (finalState.has(n)) return finalState.get(n);
  try {
    const r = await exec("gh", ["pr", "view", String(n), "--json", "state", "-q", ".state"], { cwd });
    const st = r.code === 0 ? (r.stdout ?? "").trim() : null;
    if (st === "MERGED" || st === "CLOSED") finalState.set(n, st);
    return st;
  } catch {
    return null;
  }
}

// A checkout of the run's repo for gh to run in: the first worktree state.md names that exists.
// Cells may be relative ("repo-worktrees/wkfl-1085-runs"); those resolve against the folders
// open in the window (`cwds`), any of which under the same "<repo>-worktrees/" will do.
async function repoDir(text, cwds) {
  const tried = new Set();
  for (const m of text.matchAll(/((?:\/[^\s|`)]+\/)?([\w.-]+-worktrees)\/[\w.-]+)/g)) {
    const [path, , root] = m;
    const options = path.startsWith("/") ? [path]
      : cwds.filter((c) => c.includes(`/${root}/`)).map((c) => c.slice(0, c.indexOf(`/${root}/`) + 1) + path);
    for (const dir of options) {
      if (tried.has(dir)) continue;
      tried.add(dir);
      if (await sh('test -d "$0" && echo y', dir)) return dir;
    }
  }
  return null;
}

// Every run touched in the last two weeks, open ones first, newest first.
export async function loadRuns(cwds = []) {
  const runs = [];
  for (const root of ROOTS()) {
    const out = await sh('for f in "$0"/*/state.md; do [ -f "$f" ] && stat -f "%m %N" "$f"; done', root);
    for (const line of out.split("\n").filter(Boolean)) {
      const sp = line.indexOf(" ");
      const mtime = Number(line.slice(0, sp)) * 1000;
      if (Date.now() - mtime > 14 * 86400 * 1000) continue;
      const dir = line.slice(sp + 1).slice(0, -"/state.md".length);
      const text = (await readTextFile(`${dir}/state.md`).catch(() => null)) ?? "";
      const { units, workers } = parse(text);
      const ask = /^\*\*Needs you:\*\*\s*(.+)$/m.exec(text)?.[1].trim();
      // A merge brief for a unit not yet merged means it is ready, even if state.md lags.
      const briefs = new Set((await sh('ls "$0"/merge-briefs 2>/dev/null', dir)).split("\n").map((f) => f.replace(/\.md$/, "")));
      for (const u of units) u.ready = u.word === "ready" || (briefs.has(u.tag) && u.word !== "merged" && u.word !== "dropped");
      const waiting = units.filter((u) => u.ready && u.pr);
      const cwd = waiting.length ? await repoDir(text.replace(/\\\//g, "/"), cwds) : null;
      if (cwd) {
        await Promise.all(waiting.map(async (u) => {
          const st = await prState(u.pr, cwd);
          if (st === "MERGED") { u.word = "merged"; u.ready = false; }
          if (st === "CLOSED") { u.word = "dropped"; u.ready = false; }
        }));
      }
      const verifications = Number(await sh('ls "$0"/verifications 2>/dev/null | wc -l', dir)) || 0;
      runs.push({
        name: dir.split("/").pop(), dir, mtime, text, units, workers, verifications,
        ask: ask && !/^(nothing|none|no\b|n\/a|-)/i.test(ask) ? ask : null,
        closed: /^\*\*Closed:\*\*/m.test(text),
      });
    }
  }
  return runs.sort((a, b) => (a.closed - b.closed) || b.mtime - a.mtime);
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = (cell, session) => Boolean(session) && new RegExp(`(^|[\\s(])${esc(session)}($|[\\s\\[)])`).test(cell);

// Which run and role an agent has, from its title, else from its worktree.
function placeOf(a, cwd, runs) {
  const title = String(a.title ?? "").trim();
  for (const r of runs) {
    const slug = r.name.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    const m = new RegExp(`^(?:${esc(r.name)}|${esc(slug)})-(.+)$`).exec(title);
    if (!m) continue;
    const suffix = m[1];
    const own = r.units.filter((u) => names(u.impl, title));
    const role = /verifier/i.test(suffix) ? "verifier" : "worker";
    const worker = r.workers.find((w) => names(w.session, title) || w.name === suffix);
    return { run: r, role, own: role === "worker" ? own : [], worker, name: suffix, by: "title" };
  }
  const k = worktreeKey(cwd);
  if (k) {
    for (const r of runs) {
      const own = r.units.filter((u) => u.worktree === k);
      const worker = r.workers.find((w) => w.worktree === k);
      if (!own.length && !worker) continue;
      const role = worker?.role === "verifier" || /verifier/.test(k) ? "verifier" : "worker";
      return { run: r, role, own: role === "worker" ? own : [], worker, name: worker?.name ?? own[0]?.tag ?? k.split("/")[1], by: "worktree" };
    }
  }
  return null;
}

// address -> { run, role, label, level, merged, ready: [{ pr, tag }], needs, party, summary, cwd }
export function mapAgents(list, cwdOf, runs, now = Date.now()) {
  const placed = {};
  for (const a of list) { const p = placeOf(a, cwdOf(a), runs); if (p) placed[a.address] = p; }
  // A space's run: the one most of its placed agents belong to. Its lead: the agent in the
  // space's first agent tab, unless its own title names it a worker (the orchestrator's
  // worktree may also be a unit's, so a worktree match does not stop it being the lead).
  const votes = {};
  for (const a of list) {
    const p = placed[a.address];
    if (!p) continue;
    const v = (votes[a.space] ??= new Map());
    v.set(p.run, (v.get(p.run) ?? 0) + 1);
  }
  for (const [space, v] of Object.entries(votes)) {
    const run = [...v].sort((x, y) => y[1] - x[1])[0][0];
    const first = list.filter((a) => a.space === space).sort((x, y) => x.tab_index - y.tab_index)[0];
    if (first && placed[first.address]?.by !== "title") placed[first.address] = { run, role: "lead", own: [], worker: null, name: "lead" };
  }

  const out = {};
  for (const a of list) {
    const p = placed[a.address];
    if (!p) continue;
    const { run, role, own, worker } = p;
    const short = run.name.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    const units = role === "lead" ? run.units : own;
    const merged = units.filter((u) => u.word === "merged").length;
    const ready = units.filter((u) => u.ready && u.pr).map((u) => ({ pr: u.pr, tag: u.tag }));
    // Verifiers share the run's review count, so a review is worth less than a merge.
    const level = Math.min(100, role === "verifier" ? 5 + Math.floor(run.verifications / 2) : 5 + (role === "lead" ? 2 : 3) * merged);
    const needs = role === "lead"
      ? Boolean(run.ask) || run.units.some((u) => u.word === "needs-you") || run.workers.some((w) => w.word === "needs-you")
      : own.some((u) => u.word === "needs-you") || worker?.word === "needs-you";
    const open = units.filter((u) => !["merged", "dropped"].includes(u.word)).length;
    const label = role === "lead" ? `${short} lead`
      : own.length ? own.map((u) => u.tag).slice(0, 4).join(" ") + (own.length > 4 ? "…" : "")
      : p.name;
    const summary = [
      role === "verifier" ? `${run.verifications} reviews` : `${merged} merged`,
      ready.length && `${ready.length} ready`,
      open && role !== "verifier" && `${open} open`,
    ].filter(Boolean).join(" · ");
    out[a.address] = {
      run: run.name, role, label, level, merged: role === "verifier" ? run.verifications : merged, ready, needs,
      party: run.closed && now - run.mtime < PARTY_MS, summary, cwd: cwdOf(a),
      // The session name the box remembers it by: a worker's or verifier's own name, or the
      // lead's title. Generic titles ("Claude Code") are not names.
      session: (p.by === "title" || role === "lead") && a.title && !/^claude code$/i.test(a.title.trim()) ? a.title.trim() : null,
    };
  }
  return out;
}

// ---- evolution --------------------------------------------------------------------

const CHAINS = [
  [1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15], [16, 17, 18], [19, 20], [21, 22], [23, 24],
  [25, 26], [27, 28], [29, 30, 31], [32, 33, 34], [35, 36], [37, 38], [39, 40], [41, 42], [43, 44, 45],
  [46, 47], [48, 49], [50, 51], [52, 53], [54, 55], [56, 57], [58, 59], [60, 61, 62], [63, 64, 65],
  [66, 67, 68], [69, 70, 71], [72, 73], [74, 75, 76], [77, 78], [79, 80], [81, 82], [83], [84, 85], [86, 87],
  [88, 89], [90, 91], [92, 93, 94], [95], [96, 97], [98, 99], [100, 101], [102, 103], [104, 105], [106],
  [107], [108], [109, 110], [111, 112], [113], [114], [115], [116, 117], [118, 119], [120, 121], [122], [123],
  [124], [125], [126], [127], [128], [129, 130], [131], [132], [133, 134], [133, 135], [133, 136], [137],
  [138, 139], [140, 141], [142], [143], [144], [145], [146], [147, 148, 149], [150], [151],
];
// First forms: what a new agent hatches as. Eevee appears once; its three lines differ only later.
export const BASES = [...new Set(CHAINS.map((c) => c[0]))];
export const EVOLVE_AT = [16, 32];

// The form a pick reaches at a level. Never goes back below the pick itself; Eevee's branch
// is chosen by seed so it stays the same for one agent.
// The line a Pokémon belongs to: its first form (Eevee's branches all belong to 133).
export function lineOf(id) {
  return CHAINS.find((c) => c.includes(id))?.[0] ?? id;
}

export function evolve(pick, level, seed) {
  const all = CHAINS.filter((c) => c.includes(pick));
  if (!all.length) return pick;
  const chain = pick === 133 ? all[seed % all.length] : all[0];
  const want = EVOLVE_AT.filter((l) => level >= l).length;
  return chain[Math.max(chain.indexOf(pick), Math.min(want, chain.length - 1))];
}
