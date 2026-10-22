/* The weekly podiums and the viewer's standing (Weekly rewards, My week). Server-safe: no state, no effects.
   Markup is semantic first: a podium is an ordered list, a standing is a list of four. The look lives in app/ui/stats.css (pd-*). */
import { WhoRef } from "@/components/board/people";
import type { Podium as PodiumModel, Standing } from "@/lib/models";

const ORD = ["", "1st", "2nd", "3rd"];
const PLACES = 3;

/** One category's top 3. `last` only keeps the heading ids apart from the current week's. The qualifier ("At least 5 first
    replies.") is shown for the two categories that need a minimum sample. */
export function PodiumCard({ p, last = false }: { p: PodiumModel; last?: boolean }) {
  const id = `pod-${p.key}${last ? "-last" : ""}`;
  const missing = Math.max(0, PLACES - p.entries.length);
  const qualifier = p.key === "speed" || p.key === "reopened" ? p.rule : null;
  return (
    <section className="pd-card panel" aria-labelledby={id}>
      <header className="panel-h">
        <h3 id={id}>{p.title}</h3>
        {qualifier ? <p className="sub">{qualifier}</p> : null}
      </header>
      <ol className="pd-rows">
        {p.entries.map(e => {
          const r = Math.min(e.rank, 3);
          return (
            <li key={e.person.id} className={"pd-row r" + r + (e.you ? " me" : "")}>
              <span className="pd-rk"><span className="vh">{ORD[r]} place: </span><span aria-hidden="true">{e.rank}</span></span>
              <WhoRef p={e.person} you={e.you} />
              <span className="pd-val"><b>{e.value}</b><small>{e.sub}</small></span>
            </li>
          );
        })}
        {Array.from({ length: missing }, (_, i) => (
          <li key={"empty" + i} className="pd-row pd-empty">
            <span className="pd-rk"><span className="vh">{ORD[p.entries.length + i + 1]} place: </span><span aria-hidden="true">{p.entries.length + i + 1}</span></span>
            <span className="pd-none">{p.entries.length === 0 && i === 0 ? "Nobody qualifies yet." : "Open place"}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const TAG: Record<Standing["state"], { text: string; cls: string }> = {
  podium: { text: "On the podium", cls: "chip ac" },
  chase: { text: "Within reach", cls: "chip" },
  out: { text: "Not yet", cls: "chip dash" }
};

/** The four "where you stand" cells. `inline` = one bordered row of four cells (My week); default = four compact panels (Rewards).
    State is carried by words and by shape (filled chip / outlined chip / dashed chip), never by colour alone. */
export function StandingStrip({ items, inline = false }: { items: Standing[]; inline?: boolean }) {
  return (
    <ul className={"pd-stand" + (inline ? " is-row" : "")} aria-label="Where you stand this week">
      {items.map(s => (
        <li key={s.key} className={"pd-st st-" + s.state + (inline ? "" : " panel flat")}>
          <span className="kicker">{s.title}</span>
          <div className="pd-st-main">
            <span className="pd-st-r"><span className="vh">Rank </span>{s.rank != null ? <><small aria-hidden="true">#</small>{s.rank}</> : "–"}</span>
            <span className={TAG[s.state].cls}>{TAG[s.state].text}</span>
          </div>
          <p className="pd-st-v">Yours <b>{s.value}</b></p>
          <p className="pd-st-l">{s.line}</p>
        </li>
      ))}
    </ul>
  );
}
