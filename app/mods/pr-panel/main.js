// PR panel: the pull request for the focused tab's branch, from `gh pr view`.
// Number and title (click: open in the browser), state, whether it merges cleanly, review
// decision, and every check by name with failures first. Refreshes when the focused folder
// changes and every 60 s.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, focused, exec } from "herdr";

const FIELDS = "number,title,state,isDraft,url,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,headRefName";

async function sh(cmd, args, cwd) {
  try {
    const r = await exec(cmd, args, { cwd });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}

// CheckRun and StatusContext both become { name, result: "fail" | "pending" | "pass" | "skip" }.
function checks(rollup) {
  return (rollup ?? []).map((c) => {
    const name = c.name ?? c.context ?? "check";
    const v = (c.conclusion || c.state || c.status || "").toUpperCase();
    const result =
      ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v) ? "fail"
      : ["SUCCESS"].includes(v) ? "pass"
      : ["SKIPPED", "NEUTRAL", "STALE"].includes(v) ? "skip"
      : "pending";
    return { name, result };
  }).sort((a, b) => ["fail", "pending", "pass", "skip"].indexOf(a.result) - ["fail", "pending", "pass", "skip"].indexOf(b.result));
}

export default class PrPanel extends View {
  init(_props, cx) {
    this.cwd = null;
    this.data = undefined; // undefined: loading, null: no repo/branch
    this.refresh(cx);
    cx.timer.every(2000, (cx) => { if ((focused()?.cwd ?? null) !== this.cwd) this.refresh(cx); });
    cx.timer.every(60000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    const cwd = focused()?.cwd ?? null;
    this.cwd = cwd;
    cx.spawn(async (cx) => {
      if (!cwd) { this.data = null; cx.notify(); return; }
      const branch = await sh("git", ["branch", "--show-current"], cwd);
      if (!branch.ok || !branch.out) { if (this.cwd === cwd) { this.data = null; cx.notify(); } return; }
      const view = await sh("gh", ["pr", "view", "--json", FIELDS], cwd);
      if (this.cwd !== cwd) return; // focus moved on meanwhile
      if (!view.ok) {
        const none = /no pull requests found/i.test(view.err);
        this.data = { branch: branch.out, pr: null, error: none ? "" : view.err.split("\n")[0] };
      } else {
        const pr = JSON.parse(view.out);
        this.data = { branch: branch.out, pr, checks: checks(pr.statusCheckRollup), at: new Date() };
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const d = this.data;
    const root = v_flex().id("pr-panel").size_full().p(12).gap(8).bg(t.surface).text_size(12.5);
    const head = div().text_size(11).text_color(t.dim).child("PULL REQUEST");
    if (d === undefined) return root.child(head).child(div().text_color(t.muted).child("Loading…"));
    if (d === null) return root.child(head).child(div().text_color(t.muted).child("Focus a terminal on a git branch."));
    if (!d.pr) {
      return root.child(head)
        .child(div().text_color(t.muted).child(`No PR for ${d.branch}`))
        .when(Boolean(d.error), (el) => el.child(div().text_color(t.blocked).text_size(11.5).child(d.error)));
    }
    const pr = d.pr;
    const state = pr.state === "MERGED" ? ["merged", t.done] : pr.state === "CLOSED" ? ["closed", t.muted] : pr.isDraft ? ["draft", t.muted] : ["open", t.working];
    const merge =
      pr.state !== "OPEN" ? null
      : pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY" ? ["conflicts with base: no PR workflows run", t.blocked]
      : pr.mergeStateStatus === "BEHIND" ? ["behind base", t.muted]
      : pr.mergeStateStatus === "BLOCKED" ? ["blocked by required checks or reviews", t.muted]
      : pr.mergeStateStatus === "CLEAN" ? ["ready to merge", t.done]
      : pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN" ? ["checking mergeability…", t.dim]
      : [String(pr.mergeStateStatus ?? "").toLowerCase(), t.muted];
    const review = { APPROVED: ["approved", t.done], CHANGES_REQUESTED: ["changes requested", t.blocked], REVIEW_REQUIRED: ["review required", t.muted] }[pr.reviewDecision];
    const counts = d.checks.reduce((m, c) => ((m[c.result] = (m[c.result] ?? 0) + 1), m), {});
    const mark = { fail: ["✕", t.blocked], pending: ["●", t.working], pass: ["✓", t.done], skip: ["–", t.dim] };
    return root.child(head)
      .child(
        div().id("pr-title").font_semibold().text_color(t.foreground).whitespace_normal()
          .hover((s) => s.text_color(t.accent))
          .on_click(() => exec("open", [pr.url]))
          .child(`#${pr.number} ${pr.title}`),
      )
      .child(h_flex().gap(8).flex_wrap()
        .child(div().text_color(state[1]).child(state[0]))
        .when(Boolean(review), (el) => el.child(div().text_color(review[1]).child(review[0])))
        .child(div().text_color(t.dim).child(pr.headRefOid.slice(0, 7))))
      .when(Boolean(merge), (el) => el.child(div().text_color(merge[1]).whitespace_normal().child(merge[0])))
      .child(div().text_size(11).text_color(t.dim).child(
        `CHECKS  ${counts.fail ?? 0} failing · ${counts.pending ?? 0} running · ${counts.pass ?? 0} passed`))
      .child(
        v_flex().id("pr-checks").flex_1().min_h(0).overflow_y_scrollbar().gap(3).children(
          d.checks.map((c, i) =>
            h_flex().id(`c-${i}`).gap(6)
              .child(div().w(12).text_color(mark[c.result][1]).child(mark[c.result][0]))
              .child(div().truncate().text_color(c.result === "fail" ? t.foreground : t.muted).child(c.name))),
        ),
      )
      .child(div().text_size(10.5).text_color(t.dim).child(`${d.branch} · updated ${d.at.toLocaleTimeString()}`));
  }
}
