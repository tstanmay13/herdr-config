// New task worktree (cmux-config's Cmd-N, for the Herdr app).
// Type a task name; creates <prefix>/<slug> from the freshly fetched remote default branch
// in ../<repo>-worktrees/<slug>, then opens it as a new space (mode "space", Cmd-N: one job)
// or as a tab named <slug> in the current space (mode "tab", Cmd-Shift-T: a worker in the job).
// mods/task-worktree-tab is this file with its last line set to make("tab") (mods cannot import across folders).
// Per-repo overrides: git config herdr.branchPrefix / herdr.worktreeRoot / herdr.worktreeBase
// (cmux.* keys are read too). Existing branches or paths are refused; nothing is ever removed.
// The built-in "worktree" mod (space menu) still opens and removes worktrees.

import { View, div } from "gpui-kit";
import { v_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, exec, home } from "herdr";

const DEFAULT_PREFIX = "tanmaysingh";

async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

const slugOf = (text) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
const tilde = (p) => (p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
const dirname = (p) => p.replace(/\/[^/]+\/?$/, "");

// The focused terminal's folder, else the focused space's first terminal, else home.
function startFolder() {
  const f = focused();
  if (f?.cwd) return f.cwd;
  const s = spaces().find((x) => x.id === f?.space);
  const tabs = new Set((s?.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s?.folder || home();
}

// { top, main, name, prefix, root, base, remote } for the repo holding `folder`; null outside git.
async function resolve(folder) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  const name = main.split("/").pop().replace(/\.git$/, "");
  const cfg = async (key) => {
    for (const ns of ["herdr", "cmux"]) {
      const r = await git(main, ["config", "--get", `${ns}.${key}`]);
      if (r.ok) return r.out;
    }
    return null;
  };

  const prefix = ((await cfg("branchPrefix")) ?? DEFAULT_PREFIX).replace(/\/+$/, "");
  const rootCfg = await cfg("worktreeRoot");
  const root = !rootCfg
    ? `${dirname(main)}/${name}-worktrees`
    : rootCfg.startsWith("~/") ? `${home()}/${rootCfg.slice(2)}`
    : rootCfg.startsWith("/") ? rootCfg
    : `${main}/${rootCfg}`;

  let base = await cfg("worktreeBase");
  if (!base) {
    const remotes = (await git(main, ["remote"])).out.split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (remote) {
      const head = await git(main, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
      if (head.ok && head.out) base = head.out;
      for (const b of ["main", "master"]) {
        if (!base && (await git(main, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${b}`])).ok) base = `${remote}/${b}`;
      }
    }
  }
  base = base || "HEAD";
  const remotes = (await git(main, ["remote"])).out.split("\n");
  const baseRemote = base.includes("/") && remotes.includes(base.split("/")[0]) ? base.split("/")[0] : null;
  return { top: top.out, main, name, prefix, root, base, baseRemote };
}

export function make(mode) {
  return class TaskWorktree extends View {
  init(_props, cx) {
    this.text = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.busy = false;
    this.status = "";
    this.error = "";
    this.input = InputState.new({ value: "", placeholder: mode === "tab" ? "worker name, e.g. ratelimits-worker1" : "task name, e.g. ticket search timeout" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; cx.notify(); });
    this.input.on("submit", (_e, cx) => { if (!this.busy && this.repo) cx.spawn(async (cx) => this.work(cx)); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      this.folder = startFolder();
      try { this.repo = await resolve(this.folder); } catch (e) { this.repo = null; this.error = String(e); }
      cx.notify();
    });
  }

  plan() {
    const slug = slugOf(this.text);
    if (!slug || !this.repo) return null;
    const branch = this.repo.prefix ? `${this.repo.prefix}/${slug}` : slug;
    return { slug, branch, path: `${this.repo.root}/${slug}` };
  }

  async work(cx) {
    const p = this.plan();
    if (!p) { this.error = "Type a task name."; cx.notify(); return; }
    const r = this.repo;
    this.busy = true;
    this.error = "";
    const step = (s) => { this.status = s; cx.notify(); };
    try {
      if (!(await git(r.main, ["check-ref-format", "--branch", p.branch])).ok) throw `Not a valid branch name: ${p.branch}`;
      if ((await git(r.main, ["show-ref", "--verify", "--quiet", `refs/heads/${p.branch}`])).ok) throw `Branch already exists: ${p.branch}`;
      if ((await exec("test", ["-e", p.path])).code === 0) throw `Path already exists: ${tilde(p.path)}`;
      if (r.baseRemote) {
        step(`Fetching ${r.base}…`);
        const f = await git(r.main, ["fetch", "--quiet", r.baseRemote, r.base.slice(r.baseRemote.length + 1)]);
        if (!f.ok) throw `Could not fetch ${r.base}: ${f.err}`;
      }
      step("Creating worktree…");
      await exec("mkdir", ["-p", r.root]);
      const add = await git(r.top, ["worktree", "add", "--quiet", "-b", p.branch, p.path, r.base]);
      if (!add.ok) throw add.err || "git worktree add failed.";
      if (mode === "tab") run("tab.new", { name: p.slug, folder: p.path });
      // Unnamed: the space is called after its folder (the slug) and nests under the repo.
      else run("space.new", { folder: p.path });
      closeOverlay(props()?.overlay);
    } catch (e) {
      this.error = String(e);
    }
    this.busy = false;
    this.status = "";
    cx.notify();
  }

  render() {
    const t = theme();
    const r = this.repo;
    const p = this.plan();
    const lines =
      r === undefined ? ["…"]
      : r === null ? [`${tilde(this.folder ?? "This folder")} is not in a git repository.`]
      : p ? [`branch   ${p.branch}`, `base     ${r.base}`, `path     ${tilde(p.path)}`]
      : [`branch   ${r.prefix ? `${r.prefix}/` : ""}<task>`, `base     ${r.base}`, `path     ${tilde(r.root)}/<task>`];
    const detail = v_flex().gap(2).children(lines.map((l) => div().truncate().child(l)));
    return v_flex()
      .id("task-worktree")
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(mode === "tab" ? `New worker tab${r ? ` (${r.name} worktree)` : ""}` : r ? `New task space of ${r.name}` : "New task space"))
      .when(Boolean(r), (el) =>
        el.child(
          Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1)
            .border_color(t.accent).bg(t.background).text_color(t.foreground),
        ),
      )
      .child(div().text_color(t.muted).font_family("Menlo").child(detail))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        div().text_size(11).text_color(t.dim).child(
          this.busy ? this.status || "working…" : r ? "↵ create · esc cancel" : "esc close",
        ),
      );
  }
  };
}

export default make("space");
