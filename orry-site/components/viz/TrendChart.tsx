/* My week, "Finished per week": your weeks as bars, the average person as a dashed line with hollow dots
   (mockups/me.html chart()). Drawn on the server at three widths (app/ui/orry.css shows the one that fits);
   the table behind "Table" is the text alternative. Bars = accent, average = neutral dashed. */
import type { MeModel } from "@/lib/models";
import { VARIANTS } from "./svg";

type Week = MeModel["trend"]["weeks"][number];

function Svg({ weeks, W, cls, label }: { weeks: Week[]; W: number; cls: string; label: string }) {
  const H = 240, L = 34, B = 32, T0 = 24, R = 10;
  const top = Math.max(...weeks.map(w => Math.max(w.mine, w.average)), 4);
  const max = Math.ceil(top / 2) * 2;
  const step = max > 16 ? Math.ceil(max / 8 / 2) * 2 : 2;
  const ticks: number[] = []; for (let v = 0; v <= max; v += step) ticks.push(v);
  const bw = (W - L - R) / Math.max(1, weeks.length);
  const y = (v: number) => T0 + (H - T0 - B) * (1 - v / max);
  return (
    <svg className={cls} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {ticks.map(v => (
        <g key={v}>
          <line className={v ? "g-grid" : "g-base"} x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text x={L - 8} y={y(v) + 4} textAnchor="end">{v}</text>
        </g>
      ))}
      {weeks.map((w, i) => {
        const x = L + i * bw + bw * 0.2;
        return (
          <g key={w.key}>
            <rect className="me-bar" x={x} y={y(w.mine)} width={bw * 0.6} height={y(0) - y(w.mine)} />
            <text className="t-ink" x={x + bw * 0.3} y={y(w.mine) - 6} textAnchor="middle">{w.mine}</text>
            <text x={x + bw * 0.3} y={H - 10} textAnchor="middle">{w.short}</text>
          </g>
        );
      })}
      <polyline className="avg" points={weeks.map((w, i) => `${L + i * bw + bw * 0.5},${y(w.average)}`).join(" ")} />
      {weeks.map((w, i) => <circle key={w.key} className="avg-dot" r="4" cx={L + i * bw + bw * 0.5} cy={y(w.average)} />)}
    </svg>
  );
}

export function TrendChart({ weeks, id }: { weeks: Week[]; id: string }) {
  const first = weeks[0]?.short.slice(1), last = weeks[weeks.length - 1]?.short.slice(1);
  const label = `Tickets finished per week, weeks ${first} to ${last}. You: ${weeks.map(w => w.mine).join(", ")}. Average person: ${weeks.map(w => w.average.toFixed(1)).join(", ")}.`;
  return (
    <div className="vz-box" id={id} data-view="chart">
      <div className="vz-bar">
        <ul className="vz-legend">
          <li><svg width="14" height="14" aria-hidden="true"><rect x="0" y="0" width="14" height="14" className="me-bar" /></svg>You</li>
          <li><svg width="28" height="14" aria-hidden="true"><line x1="0" y1="7" x2="28" y2="7" className="avg" /><circle cx="14" cy="7" r="4" className="avg-dot" /></svg>Average person on the roster</li>
        </ul>
      </div>
      <div className="vz-plot">
        {VARIANTS.map(v => <Svg key={v.w} weeks={weeks} W={v.w} cls={v.cls} label={label} />)}
      </div>
      <div className="vz-tbl">
        <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Tickets finished per week">
          <table className="tbl">
            <caption className="vh">Tickets finished per week: you and the average person on the roster.</caption>
            <thead><tr><th scope="col">Week</th><th scope="col" className="n">You</th><th scope="col" className="n">Average person</th></tr></thead>
            <tbody>
              {weeks.map(w => <tr key={w.key}><th scope="row">{w.short}</th><td className="n">{w.mine}</td><td className="n">{w.average.toFixed(1)}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
