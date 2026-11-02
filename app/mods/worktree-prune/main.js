// Clean up task worktrees (Cmd-Alt-K). Lists the focused repo's linked worktrees with their PR
// state, uncommitted changes and open tabs. Merged-and-clean ones start selected.
// Enter: close tabs running inside each selected worktree, `git worktree remove` it (never
// --force), and delete its local branch only when its PR was merged.
// ↑/↓ move · space toggles · enter removes · esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, notify, theme, spaces, panes, focused, exec, home, run } from "herdr";

async function sh(cmd, args, cwd) {
  try {
    const r = await exec(cmd, args, { cwd });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}
const tilde = (p) => (p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
const inside = (p, root) => p === root || p.startsWith(root + "/");

function startFolder() {
  const f = focused();
  if (f?.cwd) return f.cwd;
  const s = spaces().find((x) => x.id === f?.space);
  return s?.folder || home();
}

async function load(folder) {
  const common = await sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], folder);
  if (!common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  const list = await sh("git", ["worktree", "list", "--porcelain"], main);
  const trees = [];
  for (const block of list.out.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || path === main || lines.includes("bare")) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    trees.push({ path, branch, prunable: lines.some((l) => l.startsWith("prunable")) });
  }

  // One gh call for every PR of mine; the newest PR per branch wins.
  const prs = new Map();
  const gh = await sh("gh", ["pr", "list", "--state", "all", "--author", "@me", "--limit", "400", "--json", "number,state,headRefName"], main);
  const ghOk = gh.ok;
  if (gh.ok) {
    for (const pr of JSON.parse(gh.out || "[]").sort((a, b) => a.number - b.number)) prs.set(pr.headRefName, pr);
  }

  for (const t of trees) {
    t.pr = t.branch ? prs.get(t.branch) ?? null : null;
    t.dirty = t.prunable ? false : (await sh("git", ["status", "--porcelain"], t.path)).out !== "";
    t.tabs = [...new Set(panes().filter((p) => p.cwd && inside(p.cwd, t.path)).map((p) => p.tab))];
    t.selected = !t.dirty && t.pr?.state === "MERGED";
  }
  trees.sort((a, b) => Number(b.selected) - Number(a.selected) || a.path.localeCompare(b.path));
  return { main, name: main.split("/").pop(), trees, ghOk, ghErr: gh.err };
}

export default class WorktreePrune extends View {
  init(_props, cx) {
    this.repo = undefined;
    this.at = 0;
    this.busy = false;
    this.status = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(400, () => this.handle.focus());
    cx.spawn(async (cx) => {
      this.folder = startFolder();
      try { this.repo = await load(this.folder); } catch (e) { this.repo = null; this.status = String(e); }
      cx.notify();
    });
  }

  selectable(t) { return !t.dirty; }

  key(e, cx) {
    const trees = this.repo?.trees ?? [];
    if (e.key === "escape") return closeOverlay(props()?.overlay);
    if (this.busy) return;
    if ((e.key === "down" || e.key === "up") && trees.length) this.at = (this.at + (e.key === "down" ? 1 : trees.length - 1)) % trees.length;
    else if (e.key === "space" && trees[this.at] && this.selectable(trees[this.at])) trees[this.at].selected = !trees[this.at].selected;
    else if (e.key === "enter") cx.spawn(async (cx) => this.prune(cx));
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  async prune(cx) {
    const chosen = (this.repo?.trees ?? []).filter((t) => t.selected && this.selectable(t));
    if (!chosen.length) { this.status = "Nothing selected."; cx.notify(); return; }
    this.busy = true;
    const done = [], failed = [];
    for (const t of chosen) {
      this.status = `Removing ${tilde(t.path)}…`;
      cx.notify();
      for (const tab of t.tabs) run("tab.close", { id: tab, confirmed: true });
      const rm = await sh("git", ["worktree", "remove", t.path], this.repo.main);
      if (!rm.ok) { failed.push(`${t.path.split("/").pop()}: ${rm.err.split("\n")[0]}`); continue; }
      if (t.branch && t.pr?.state === "MERGED") await sh("git", ["branch", "-D", t.branch], this.repo.main);
      done.push(t.path.split("/").pop());
    }
    await sh("git", ["worktree", "prune"], this.repo.main);
    this.busy = false;
    if (done.length) notify({ title: `Removed ${done.length} worktree${done.length > 1 ? "s" : ""}`, body: done.join(", "), level: "success", timeout: 5000 });
    if (failed.length) {
      this.status = failed.join("\n");
      this.repo = await load(this.folder);
      this.at = 0;
      cx.notify();
      return;
    }
    closeOverlay(props()?.overlay);
  }

  render() {
    const t = theme();
    const r = this.repo;
    const trees = r?.trees ?? [];
    const prLabel = (x) => (x.pr ? `#${x.pr.number} ${x.pr.state.toLowerCase()}` : r?.ghOk ? "no PR" : "PR ?");
    const row = (x, i) => {
      const flags = [x.dirty && "uncommitted changes", x.tabs.length && `${x.tabs.length} tab${x.tabs.length > 1 ? "s" : ""} will close`, x.pr?.state === "MERGED" && "branch deleted", x.prunable && "folder missing"].filter(Boolean);
      return h_flex()
        .id(`wt-${i}`)
        .gap(10)
        .px(8)
        .py(5)
        .rounded(6)
        .when(i === this.at, (el) => el.bg(t.selected))
        .on_click((_e, cx) => { this.at = i; if (this.selectable(x)) x.selected = !x.selected; cx.notify(); })
        .child(div().w(18).text_color(this.selectable(x) ? t.foreground : t.dim).child(x.selected ? "☑" : this.selectable(x) ? "☐" : "–"))
        .child(
          v_flex().flex_1().min_w(0)
            .child(h_flex().gap(8)
              .child(div().truncate().text_color(t.foreground).child(x.path.split("/").pop()))
              .child(div().text_color(x.pr?.state === "MERGED" ? t.done : x.pr?.state === "OPEN" ? t.working : t.muted).child(prLabel(x))))
            .child(div().truncate().text_size(11.5).text_color(x.dirty ? t.blocked : t.dim).child(flags.length ? flags.join(" · ") : x.branch ?? "detached")),
        );
    };
    return v_flex()
      .id("worktree-prune")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(r ? `Clean up ${r.name} worktrees` : "Clean up worktrees"))
      .when(r === undefined, (el) => el.child(div().text_color(t.muted).child("Reading worktrees and PRs…")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${tilde(this.folder ?? "")} is not in a git repository.`)))
      .when(Boolean(r) && !r.ghOk, (el) => el.child(div().text_color(t.blocked).text_size(11.5).child(`gh failed, PR states unknown: ${r.ghErr.split("\n")[0]}`)))
      .when(Boolean(r) && trees.length === 0, (el) => el.child(div().text_color(t.muted).child("No linked worktrees.")))
      .child(v_flex().id("wt-list").flex_1().min_h(0).overflow_y_scrollbar().gap(2).children(trees.map(row)))
      .when(Boolean(this.status), (el) => el.child(div().text_color(t.blocked).whitespace_normal().child(this.status)))
      .child(div().text_size(11).text_color(t.dim).child(this.busy ? "removing…" : "↑↓ move · space toggle · ↵ remove selected · esc close"));
  }
}
