// node app/tests/for-you-dry-run.mjs [seen.json] — what the job panel's "For you" list shows for
// the live runs, and the notifications it would post given a seen map (default: none seen yet
// after the baseline, i.e. every item counts as new). Reads only; writes nothing.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { forYouItems, newItems, notice } from "../mods/job-panel/forYou.js";
import { tables, runAsk, strictWord, prNumber, forYouSection } from "../mods/job-panel/state.js";

const root = `${process.env.HOME}/.config/agent-orchestrate/runs`;
const runs = readdirSync(root).map((name) => ({ name, f: `${root}/${name}/state.md` }))
  .filter((r) => existsSync(r.f)).map((r) => ({ ...r, mtime: statSync(r.f).mtimeMs / 1000 }))
  .sort((a, b) => b.mtime - a.mtime).filter((r) => Date.now() / 1000 - r.mtime < 14 * 86400).slice(0, 15);
const byRun = {};
for (const r of runs) {
  const text = readFileSync(r.f, "utf8");
  if (/^\*\*Closed:\*\*/m.test(text)) continue;
  const t = tables(text);
  byRun[r.name] = forYouItems(r.name, { ...t, ask: runAsk(text), forYou: forYouSection(text) }, strictWord, prNumber);
}
console.log("FOR YOU (runs with a ## For you section: " + Object.entries(byRun).filter(([, v]) => v.some((x) => x.todo)).map(([k]) => k).join(", ") + ")");
for (const x of Object.values(byRun).flat().sort((a, b) => (a.word === "ready" ? 0 : 1) - (b.word === "ready" ? 0 : 1)))
  console.log(`  ${x.word.padEnd(9)} ${x.run.padEnd(32)} ${(x.unit || "run").padEnd(28)} ${x.pr ? "#" + x.pr : "".padEnd(6)}  ${x.ask.slice(0, 70)}`);
const seen = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : { "_baseline": [] };
const { fresh } = newItems(seen, byRun);
console.log("\nNOTIFICATIONS (one per run)");
for (const [run, items] of Object.entries(fresh)) {
  const { title, body } = notice(run.replace(/^\d{4}-\d{2}-\d{2}-/, ""), items);
  console.log(`  ${title}\n    ${body.replace(/\n/g, "\n    ")}`);
}
