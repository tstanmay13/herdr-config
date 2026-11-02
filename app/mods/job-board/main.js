// Job board: the orchestrate run for the focused space, from its state.md units table.
// Run choice: the run whose state.md names a worktree open in the focused space; otherwise the
// most recently updated run. Chips switch to another recent run. Each unit shows PR, status,
// implementer/verifier, and whether the verified SHA matches the tip.
// Runs: $ORCHESTRATE_HOME or ~/.config/agent-orchestrate, plus legacy ~/.claude/orchestrate.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, focused, spaces, panes, exec, home, readTextFile, watchFolder } from "herdr";

const ROOTS = () => [`${home()}/.config/agent-orchestrate/runs`, `${home()}/.claude/orchestrate/runs`];

async function sh(cmd, args) {
  try {
    const r = await exec(cmd, args);
    return { ok: r.code === 0, out: (r.stdout ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

// Every run with a state.md: { name, dir, mtime }, newest first.
async function listRuns() {
  const runs = [];
  for (const root of ROOTS()) {
    const r = await sh("/bin/sh", ["-c", 'for f in "$0"/*/state.md; do [ -f "$f" ] && stat -f "%m %N" "$f"; done', root]);
    for (const line of r.out.split("\n").filter(Boolean)) {
      const sp = line.indexOf(" ");
      const file = line.slice(sp + 1);
      const dir = file.slice(0, -"/state.md".length);
      runs.push({ name: dir.split("/").pop(), dir, mtime: Number(line.slice(0, sp)) });
    }
  }
  return runs.sort((a, b) => b.mtime - a.mtime);
}

// The first markdown table whose header has a "unit" column: [{ column: value }].
function units(md) {
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
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

// "repo-worktrees/x" style keys for every folder open in the focused space.
function spaceKeys() {
  const s = spaces().find((x) => x.id === focused()?.space);
  const tabs = new Set((s?.tabs ?? []).map((t) => t.id));
  const cwds = panes().filter((p) => tabs.has(p.tab) && p.cwd).map((p) => p.cwd);
  return [...new Set(cwds.map((c) => c.split("/").slice(-2).join("/")))].filter((k) => k.includes("/"));
}

const ago = (mtime) => {
  const d = Date.now() / 1000 - mtime;
  return d < 90 ? "just now" : d < 3600 ? `${Math.round(d / 60)}m ago` : d < 86400 ? `${Math.round(d / 3600)}h ago` : `${Math.round(d / 86400)}d ago`;
};
const sha = (s) => (s.match(/\b[0-9a-f]{7,40}\b/) ?? [""])[0];
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export default class JobBoard extends View {
  init(_props, cx) {
    this.runs = [];
    this.pinned = null; // a run name picked by click; cleared when the focused space changes
    this.space = focused()?.space ?? null;
    this.run = undefined;
    this.reload(cx);
    cx.timer.every(2000, (cx) => {
      const s = focused()?.space ?? null;
      if (s !== this.space) { this.space = s; this.pinned = null; this.reload(cx); }
    });
    cx.timer.every(30000, (cx) => this.reload(cx));
    for (const root of ROOTS()) {
      cx.spawn(async (cx) => {
        for (;;) {
          try { await watchFolder(root); } catch { return; } // root missing: rely on the timer
          this.reload(cx);
        }
      });
    }
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      const runs = await listRuns();
      const texts = new Map();
      const read = async (r) => {
        if (!texts.has(r.dir)) texts.set(r.dir, (await readTextFile(`${r.dir}/state.md`).catch(() => null)) ?? "");
        return texts.get(r.dir);
      };
      let pick = runs.find((r) => r.name === this.pinned);
      if (!pick) {
        const keys = spaceKeys();
        for (const r of runs.slice(0, 15)) {
          const text = await read(r);
          if (keys.some((k) => text.includes(k))) { pick = r; break; }
        }
      }
      pick = pick ?? runs[0];
      this.runs = runs;
      this.run = pick ? { ...pick, units: units(await read(pick)), matched: !this.pinned && pick !== runs[0] } : null;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const root = v_flex().id("job-board").size_full().p(12).gap(8).bg(t.surface).text_size(12.5);
    const head = div().text_size(11).text_color(t.dim).child("JOB BOARD");
    const r = this.run;
    if (r === undefined) return root.child(head).child(div().text_color(t.muted).child("Loading…"));
    if (r === null) return root.child(head).child(div().text_color(t.muted).child("No orchestrate runs yet."));
    const chips = this.runs.slice(0, 6).map((x, i) =>
      div().id(`run-${i}`).px(6).py(2).rounded(5).text_size(11)
        .bg(x.name === r.name ? t.selected : t.raised)
        .text_color(x.name === r.name ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pinned = x.name; this.reload(cx); })
        .child(short(x.name.replace(/^\d{4}-\d{2}-\d{2}-/, ""), 22)));
    const card = (u, i) => {
      const tip = sha(u["tip"] ?? "");
      const verified = u["verified tip"] ?? "";
      const vsha = sha(verified);
      const check =
        !tip ? null
        : !vsha ? ["not verified yet", t.muted]
        : vsha.startsWith(tip.slice(0, 7)) || tip.startsWith(vsha.slice(0, 7)) ? [`verified at tip ${tip.slice(0, 7)}`, t.done]
        : [`tip ${tip.slice(0, 7)} ≠ verified ${vsha.slice(0, 7)}`, t.blocked];
      const who = [u["implementer"] && `impl ${u["implementer"].split(" ")[0]}`, u["verifier"] && `verify ${u["verifier"].split(" ")[0]}`].filter(Boolean).join(" · ");
      return v_flex().id(`unit-${i}`).p(8).gap(3).rounded(6).bg(t.background)
        .child(h_flex().gap(8).justify_between()
          .child(div().truncate().font_semibold().text_color(t.foreground).child(u["unit"] || "unit"))
          .child(div().text_color(t.accent).child((/\d{3,}/.exec(u["pr"] ?? "") ?? [null]).map((n) => (n ? `#${n}` : ""))[0])))
        .child(div().text_color(t.muted).whitespace_normal().child(short(u["status"] ?? "", 220)))
        .when(Boolean(who), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(who)))
        .when(Boolean(check), (el) => el.child(div().text_size(11).text_color(check[1]).child(check[0])));
    };
    return root.child(head)
      .child(h_flex().gap(4).flex_wrap().children(chips))
      .child(div().text_size(11).text_color(t.dim).child(`${r.name} · updated ${ago(r.mtime)}${r.matched ? " · matches this space" : ""}`))
      .when(r.units.length === 0, (el) => el.child(div().text_color(t.muted).child("No units table in state.md yet.")))
      .child(v_flex().id("units").flex_1().min_h(0).overflow_y_scrollbar().gap(6).children(r.units.map(card)));
  }
}
