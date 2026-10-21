/* "Who finished tickets": one 100 % stacked bar per week, four series (helpers solid, participants outline,
   Orry hatched, other closes dotted), from mockups/stats.html drawWho(). Drawn on the server at three widths;
   app/ui/orry.css shows the one that fits. The seven-way split is in the tooltip and the table. */
import type { StatsModel } from "@/lib/models";
import { esc, pct, VARIANTS } from "./svg";

type Week = StatsModel["whoChart"]["weeks"][number];
const SERIES = [
  { key: "helper", name: "Helpers", short: "Helper" },
  { key: "self", name: "Participants themselves", short: "Self" },
  { key: "orry", name: "Orry (all kinds)", short: "Orry" },
  { key: "other", name: "Other closes", short: "Other" }
] as const;

const four = (w: Week) => [w.four.helper, w.four.self, w.four.orry, w.four.other];

function tipFor(w: Week): string {
  const f = four(w), tot = w.total;
  const row = (name: string, n: number) => `<div class="tr"><span>${name}</span><b>${n} (${pct(n, tot)}&nbsp;%)</b></div>`;
  const sub = (name: string, n: number) => `<div class="tr"><span>&nbsp;&nbsp;${name}</span><b>${n}</b></div>`;
  return `<b>${esc(w.short)}${w.provisional ? ", provisional" : ""}: ${tot} finished</b>` +
    row("Helpers", f[0]) + row("Participants themselves", f[1]) + row("Orry (all kinds)", f[2]) +
    sub("last-word rule", w.parts.orry_last_word) + sub("judge", w.parts.orry_judge) +
    sub("history import, resolved", w.parts.import_resolved) + sub("history import, closed", w.parts.import_closed) +
    row("Other closes", f[3]);
}

function Svg({ weeks, W, cls, label }: { weeks: Week[]; W: number; cls: string; label: string }) {
  const direct = W >= 560;
  const H = 304, L = 48, R = direct ? 104 : 6, T = 28, B = 64, ph = H - T - B, pw = W - L - R, n = Math.max(1, weeks.length), slot = pw / n;
  const bw = Math.min(56, Math.floor(slot * 0.62));
  const last = weeks.length - 1;
  return (
    <svg className={cls} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <g shapeRendering="crispEdges">
        {[0, 25, 50, 75, 100].map(v => {
          const y = Math.round(T + ph - (ph * v) / 100) + 0.5;
          return (
            <g key={v}>
              <line className={v ? "g-grid" : "g-base"} x1={L} x2={W - R} y1={y} y2={y} />
              <text x={L - 8} y={y + 4} textAnchor="end">{v}%</text>
            </g>
          );
        })}
        <text x={L - 8} y={T - 8} textAnchor="end" className="t-ink">n</text>
        <text x={L - 8} y={T + ph + 34} textAnchor="end" className="t-ink">Orry</text>
        {weeks.map((w, i) => {
          const f = four(w), tot = w.total;
          const x = Math.round(L + i * slot + (slot - bw) / 2);
          const sx = Math.round(L + i * slot), cx = Math.round(L + i * slot + slot / 2);
          let cum = 0;
          const segs = f.map((c, k) => {
            if (!c || !tot) return null;
            const y0 = Math.round(T + ph - (ph * cum) / tot); cum += c;
            const y1 = Math.round(T + ph - (ph * cum) / tot);
            const h = Math.max(1, y0 - y1 - 2), yy = y1 + 1;
            if (k === 1) return <rect key={k} x={x + 1} y={yy + 1} width={bw - 2} height={Math.max(1, h - 2)} className="s-self" />;
            if (k === 2) return (
              <g key={k}>
                <rect x={x} y={yy} width={bw} height={h} fill="url(#tx-hatch)" />
                <rect x={x + 0.5} y={yy + 0.5} width={bw - 1} height={Math.max(1, h - 1)} className="s-edge" />
              </g>
            );
            if (k === 3) return <rect key={k} x={x} y={yy} width={bw} height={h} fill="url(#tx-dotm)" />;
            return <rect key={k} x={x} y={yy} width={bw} height={h} className="s-helper" />;
          });
          let c2 = 0;
          return (
            <g key={w.key}>
              <rect className="hl-col" x={sx} y={T} width={Math.round(slot)} height={ph} />
              {segs}
              <text x={cx} y={T - 8} textAnchor="middle" className="t-ink">{tot}</text>
              <text x={cx} y={T + ph + 16} textAnchor="middle" className={i === last ? "t-ink" : undefined}>{w.short}</text>
              <text x={cx} y={T + ph + 34} textAnchor="middle" className="t-ink">{pct(f[2], tot)}%</text>
              {w.provisional ? (
                <>
                  <text x={cx} y={T + ph + 52} textAnchor="middle">prov.</text>
                  <rect className="s-prov" x={x - 4} y={T - 3} width={bw + 8} height={ph + 6} />
                </>
              ) : null}
              {direct && i === last && tot ? f.map((c, k) => {
                const mid = T + ph - (ph * (c2 + c / 2)) / tot; c2 += c;
                return c ? <text key={`d${k}`} x={x + bw + 12} y={Math.round(mid) + 4} className="t-ink">{SERIES[k].short} {pct(c, tot)}%</text> : null;
              }) : null}
              <rect className="hit" x={sx} y={T} width={Math.round(slot)} height={ph} data-tip={tipFor(w)} />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function Swatch({ k }: { k: (typeof SERIES)[number]["key"] }) {
  switch (k) {
    case "helper": return <rect x="0" y="0" width="14" height="14" className="s-helper" />;
    case "self": return <rect x="1" y="1" width="12" height="12" className="s-self" />;
    case "orry": return <><rect x="0" y="0" width="14" height="14" fill="url(#tx-hatch)" /><rect x=".5" y=".5" width="13" height="13" className="s-edge" /></>;
    default: return <rect x="0" y="0" width="14" height="14" fill="url(#tx-dotm)" />;
  }
}

export function whoLabel(weeks: Week[]): string {
  if (!weeks.length) return "Who finished tickets: no weeks to show.";
  const w = weeks[weeks.length - 1], f = four(w);
  return `Who finished tickets, weeks ${weeks[0].short.replace("W", "")} to ${w.short.replace("W", "")}, share of each week. ` +
    `In week ${w.short.replace("W", "")}, ${w.total} finished: helpers ${f[0]}, participants themselves ${f[1]}, Orry ${f[2]} (${pct(f[2], w.total)} percent), other closes ${f[3]}.` +
    (w.provisional ? ` Week ${w.short.replace("W", "")} is provisional.` : "");
}

export function WhoChart({ weeks, id }: { weeks: Week[]; id: string }) {
  const label = whoLabel(weeks);
  const th = (l: string, sh: string, cls = "") => <th scope="col" className={`n ${cls}`}><span className="lh">{l}</span><span className="sh">{sh || l}</span></th>;
  return (
    <div className="vz-box" id={id} data-view="chart">
      <div className="vz-bar">
        <ul className="vz-legend">
          {SERIES.map(s => <li key={s.key}><svg width="14" height="14" aria-hidden="true"><Swatch k={s.key} /></svg>{s.name}</li>)}
          <li><svg width="14" height="14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" className="s-prov" /></svg>Provisional week</li>
        </ul>
      </div>
      <div className="vz-plot">
        {VARIANTS.map(v => <Svg key={v.w} weeks={weeks} W={v.w} cls={v.cls} label={label} />)}
      </div>
      <div className="vz-tbl">
        <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Who finished tickets, table">
          <table className="tbl">
            <caption className="vh">Tickets finished per week, by who finished them. Orry (all kinds) is the sum of the four columns on its right.</caption>
            <thead>
              <tr>
                <th scope="col">Week</th>
                {th("Helpers", "Helper")}{th("Participants themselves", "Self")}{th("Orry (all kinds)", "Orry")}{th("Other closes", "Other")}
                <th scope="col" className="n">Total</th>
                {th("Last-word rule", "", "det")}{th("Judge", "", "det")}{th("Import, resolved", "", "det")}{th("Import, closed", "", "det")}
              </tr>
            </thead>
            <tbody>
              {weeks.map(w => {
                const f = four(w);
                return (
                  <tr key={w.key}>
                    <th scope="row">{w.short}{w.provisional ? " (prov.)" : ""}</th>
                    <td className="n">{f[0]}</td><td className="n">{f[1]}</td>
                    <td className="n">{f[2]}<span className="pc"> ({pct(f[2], w.total)}&nbsp;%)</span></td>
                    <td className="n">{f[3]}</td><td className="n">{w.total}</td>
                    <td className="n det">{w.parts.orry_last_word}</td><td className="n det">{w.parts.orry_judge}</td>
                    <td className="n det">{w.parts.import_resolved}</td><td className="n det">{w.parts.import_closed}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
