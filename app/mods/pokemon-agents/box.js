// The box (ours): XP belongs to a Pokémon line, not to a session. Implementers are one-off
// sessions, so a level tied to the session would never grow; banked on the line, every merge
// counts, and the next agent that gets the line starts where the last one stopped.
//
// Saved in shared state "pokemon-agents.box":
//   xp:       { <line>: number }            line = the first form's dex number
//   credited: { <key>: true | number }     what has been paid out, so nothing pays twice
//   sessions: { <session name>: { line, role, run } }  who was which line, kept after they exit
//
// Pay: implementer 3 per merged unit it owns, lead 2 per merged unit in its run,
// verifier 1 per two reviews in its run. Level = 5 + floor(xp), up to 100.
import { shared, setShared } from "herdr";

const KEY = "pokemon-agents.box";
export const PAY = { worker: 3, lead: 2, review: 0.5 };

export function loadBox() {
  const s = shared(KEY);
  const ok = s && typeof s === "object";
  return { xp: ok && s.xp ? s.xp : {}, credited: ok && s.credited ? s.credited : {}, sessions: ok && s.sessions ? s.sessions : {} };
}

export const levelOf = (box, line) => Math.min(100, 5 + Math.floor(box.xp[line] ?? 0));

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = (cell, session) => Boolean(session) && new RegExp(`(^|[\\s(])${esc(session)}($|[\\s\\[)])`).test(cell ?? "");

// Records who is which line now, then pays every merge and review not paid yet.
// `seen`: [{ session, line, role, run }] for agents on screen. Returns true when the box changed.
export function settle(box, seen, runs) {
  let changed = false;
  for (const s of seen) {
    if (!s.session) continue;
    const old = box.sessions[s.session];
    if (!old || old.line !== s.line || old.role !== s.role || old.run !== s.run) {
      box.sessions[s.session] = { line: s.line, role: s.role, run: s.run };
      changed = true;
    }
  }
  const pay = (key, line, amount) => {
    if (box.credited[key] || line == null) return;
    box.credited[key] = true;
    box.xp[line] = (box.xp[line] ?? 0) + amount;
    changed = true;
  };
  const sessions = Object.entries(box.sessions);
  for (const r of runs) {
    const here = sessions.filter(([, s]) => s.run === r.name);
    for (const u of r.units) {
      if (u.word !== "merged") continue;
      for (const [name, s] of here) {
        if (s.role === "worker" && names(u.impl, name)) pay(`m:${r.name}:${u.name}:${name}`, s.line, PAY.worker);
        if (s.role === "lead") pay(`l:${r.name}:${u.name}:${name}`, s.line, PAY.lead);
      }
    }
    // Reviews are a count per run: pay each verifier line for the reviews since it last looked.
    for (const [name, s] of here) {
      if (s.role !== "verifier") continue;
      const key = `v:${r.name}:${name}`;
      const before = typeof box.credited[key] === "number" ? box.credited[key] : 0;
      if (r.verifications > before) {
        box.xp[s.line] = (box.xp[s.line] ?? 0) + PAY.review * (r.verifications - before);
        box.credited[key] = r.verifications;
        changed = true;
      }
    }
  }
  return changed;
}

export function saveBox(box) {
  setShared(KEY, box);
}
