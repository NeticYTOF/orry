"use client";
/* The Leaderboard's period and measure switches and the ranked table (PLAN 4.17; mockups/earlier-drafts/leaderboard.html).
   The ranks come from the server (ties share a rank; "Too few" ranks last); this only re-sorts by the chosen measure.
   The period reloads the page (?period=8w); the measure stays in ?measure= with replaceState. */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { LeaderboardModel, LeaderboardRow } from "@/lib/models";
import { WhoRef } from "@/components/board/people";

export type Measure = "fin" | "med" | "re";
const RANK: Record<Measure, keyof LeaderboardRow["ranks"]> = { fin: "finished", med: "median", re: "reopened" };
const CAPTION: Record<Measure, string> = { fin: "tickets finished, most first", med: "median first reply, fastest first", re: "reopened share, lowest first" };

export function rankedBy(rows: LeaderboardRow[], by: Measure): LeaderboardRow[] {
  const k = RANK[by];
  return rows.slice().sort((a, b) => (a.ranks[k] ?? 1e9) - (b.ranks[k] ?? 1e9) || a.person.label.localeCompare(b.person.label));
}

export function LeaderboardClient({ m, measure, base = "/leaderboard", keep }: { m: LeaderboardModel; measure: Measure; base?: string; keep?: Record<string, string> }) {
  const router = useRouter();
  const [by, setBy] = useState<Measure>(measure);
  const [busy, start] = useTransition();
  const rows = useMemo(() => rankedBy(m.rows, by), [m.rows, by]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (by === "fin") q.delete("measure"); else q.set("measure", by);
    const s = q.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${s ? `?${s}` : ""}`);
  }, [by]);

  const setPeriod = (p: "week" | "8w") => {
    const q = new URLSearchParams(keep);
    if (p === "8w") q.set("period", "8w");
    if (by !== "fin") q.set("measure", by);
    const s = q.toString();
    start(() => router.push(`${base}${s ? `?${s}` : ""}`, { scroll: false }));
  };

  return (
    <>
      <div className="pd-tools" id="tools">
        <div className="field"><span className="label" id="lbl-per">Period</span>
          <div className="tabs" role="group" aria-labelledby="lbl-per" id="perChips" aria-busy={busy || undefined}>
            {m.periods.map(p => <button key={p.key} type="button" data-per={p.key} aria-pressed={p.current} onClick={() => { if (!p.current) setPeriod(p.key); }}>{p.label}</button>)}
          </div>
        </div>
        <div className="field"><label htmlFor="sortSel">Rank by</label>
          <select id="sortSel" value={by} onChange={e => setBy(e.target.value as Measure)}>
            <option value="fin">Tickets finished</option>
            <option value="med">Fastest first reply</option>
            <option value="re">Fewest reopened</option>
          </select>
        </div>
        <p className="pd-result" id="result" aria-live="polite">{m.periodLabel} · {m.rows.length} {m.rows.length === 1 ? "person" : "people"} shown</p>
      </div>

      <div className="tbl-wrap">
        <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Leaderboard table">
          <table className="tbl pd-lb" id="tbl">
            <caption className="vh" id="cap">Ranked by {CAPTION[by]}.</caption>
            <thead><tr>
              <th scope="col" className="n">Rank</th><th scope="col">Person</th>
              <th scope="col" className="n"><button className="sortbtn" type="button" aria-pressed={by === "fin"} onClick={() => setBy("fin")}>Finished</button></th>
              <th scope="col" className="n">First replies</th>
              <th scope="col" className="n"><button className="sortbtn" type="button" aria-pressed={by === "med"} onClick={() => setBy("med")}>Median first reply</button></th>
              <th scope="col" className="n"><button className="sortbtn" type="button" aria-pressed={by === "re"} onClick={() => setBy("re")}>Reopened</button></th>
            </tr></thead>
            <tbody id="rows">
              {rows.length ? rows.map(r => (
                <tr key={r.person.id} className={r.you ? "me" : undefined}>
                  <td className="n" data-l="Rank"><span className="rank">{r.ranks[RANK[by]] ?? "–"}</span></td>
                  <th scope="row"><WhoRef p={r.person} you={r.you} /></th>
                  <td className="n" data-l="Finished">{r.finished}</td>
                  <td className="n" data-l="First replies">{r.firstReplies}</td>
                  <td className={"n" + (r.tooFew ? " few" : "")} data-l="Median first reply">{r.median}</td>
                  <td className="n" data-l="Reopened">{r.reopenedText}</td>
                </tr>
              )) : <tr><td colSpan={6} className="empty-note">Nobody has tickets in this period yet.</td></tr>}
            </tbody>
            <tfoot><tr><th scope="row" colSpan={2}>Team, everyone included</th><td className="n" data-l="Finished">{m.team.finished}</td><td className="n" data-l="First replies">{m.team.firstReplies}</td><td className="n" data-l="Median first reply">{m.team.median}</td><td className="n" data-l="Reopened">{m.team.reopened}</td></tr></tfoot>
          </table>
        </div>
      </div>
      <p className="caption" id="hiddenNote">{m.hiddenNote}</p>
    </>
  );
}
