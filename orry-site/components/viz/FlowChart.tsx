/* "Created and finished per week": two step lines on one axis with the gap shaded, from mockups/stats.html
   drawFlow(). The provisional last week is dashed. Drawn on the server at three widths; app/ui/orry.css shows the one
   that fits. Created = thin grey line + filled square, finished = thick accent line + hollow square, so the two read
   apart without colour. The table behind "Table" is the text alternative. */
import type { StatsModel } from "@/lib/models";
import { esc, niceMax, SIGN, VARIANTS } from "./svg";

type Week = StatsModel["flowChart"]["weeks"][number];

function Svg({ weeks, W, cls, label }: { weeks: Week[]; W: number; cls: string; label: string }) {
  const direct = W >= 560;
  const n = weeks.length;
  const H = 288, L = 40, R = direct ? 100 : 14, T = 10, B = 52, ph = H - T - B, pw = W - L - R, slot = pw / Math.max(1, n);
  const max = niceMax(Math.max(1, ...weeks.flatMap(w => [w.created, w.finished])));
  const step = max > 100 ? 50 : max > 40 ? 20 : 10;
  const ticks: number[] = []; for (let v = 0; v <= max; v += step) ticks.push(v);
  const y = (v: number) => Math.round(T + ph - (ph * v) / max);
  const xs = (i: number) => Math.round(L + i * slot);
  const thin = W < 520 ? 3 : 1;
  const lastProv = n > 1 && weeks[n - 1].provisional;
  const solidUpTo = lastProv ? n - 1 : n;
  const solid = (k: "created" | "finished") => weeks.slice(0, solidUpTo).map((w, i) => `${i ? "V" + y(w[k]) : "M" + xs(0) + "," + y(w[k])}H${xs(i + 1)}`).join("");
  const dash = (k: "created" | "finished") => `M${xs(n - 1)},${y(weeks[n - 2][k])}V${y(weeks[n - 1][k])}H${xs(n)}`;
  const last = weeks[n - 1];
  const ex = xs(n);
  let ly1 = last ? y(last.created) + 4 : 0, ly2 = last ? y(last.finished) + 4 : 0;
  if (last && Math.abs(ly1 - ly2) < 15) {
    const mid = (ly1 + ly2) / 2; ly1 = Math.round(mid - 8); ly2 = Math.round(mid + 8);
    if (last.created < last.finished) [ly1, ly2] = [ly2, ly1];
  }
  return (
    <svg className={cls} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <g shapeRendering="crispEdges">
        {ticks.map(v => (
          <g key={v}>
            <line className={v ? "g-grid" : "g-base"} x1={L} x2={W - R + 8} y1={y(v) + 0.5} y2={y(v) + 0.5} />
            <text x={L - 8} y={y(v) + 4.5} textAnchor="end">{v}</text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const cx = Math.round(L + i * slot + slot / 2);
          return (
            <g key={w.key}>
              <rect className="gap-fill" x={xs(i)} y={Math.min(y(w.created), y(w.finished))} width={Math.max(1, xs(i + 1) - xs(i))} height={Math.max(1, Math.abs(y(w.created) - y(w.finished)))} />
              {i % thin === 0 || i === n - 1 ? (
                <>
                  <text x={cx} y={T + ph + 16} textAnchor="middle" className={i === n - 1 ? "t-ink" : undefined}>{w.short}</text>
                  <text x={cx} y={T + ph + 34} textAnchor="middle" className="t-ink">{SIGN(w.net)}</text>
                </>
              ) : null}
            </g>
          );
        })}
        <text x={L - 8} y={T + ph + 34} textAnchor="end" className="t-ink">Net</text>
        <line className="x-hair" x1="0" x2="0" y1={T} y2={T + ph} visibility="hidden" />
      </g>
      {n ? (
        <>
          <path className="l-created" d={solid("created")} />
          <path className="l-finished" d={solid("finished")} />
          {lastProv ? <><path className="l-created l-dash" d={dash("created")} /><path className="l-finished l-dash" d={dash("finished")} /></> : null}
          <rect x={ex - 4} y={y(last.created) - 4} width="8" height="8" className="m-created" />
          <rect x={ex - 4} y={y(last.finished) - 4} width="8" height="8" className="m-finished" />
          {direct ? <><text x={ex + 10} y={ly1} className="t-ink">Created {last.created}</text><text x={ex + 10} y={ly2} className="t-ink">Finished {last.finished}</text></> : null}
        </>
      ) : null}
      {weeks.map((w, i) => (
        <rect key={w.key} className="hit" x={xs(i)} y={T} width={Math.max(1, xs(i + 1) - xs(i))} height={ph}
          data-hx={Math.round(L + i * slot + slot / 2) + 0.5}
          data-tip={`<b>${esc(w.short)}${w.provisional ? ", provisional" : ""}</b><div class="tr"><span>Created</span><b>${w.created}</b></div><div class="tr"><span>Finished</span><b>${w.finished}</b></div><div class="tr"><span>Net</span><b>${SIGN(w.net)}</b></div>`} />
      ))}
    </svg>
  );
}

export function flowLabel(weeks: Week[], sentence: string): string {
  if (!weeks.length) return "Tickets created and finished per week: no weeks to show.";
  const a = weeks[0], z = weeks[weeks.length - 1];
  return `Tickets created and finished per week, weeks ${a.short.slice(1)} to ${z.short.slice(1)}. ${sentence} Week ${z.short.slice(1)}: ${z.created} created, ${z.finished} finished${z.provisional ? ", still provisional" : ""}.`;
}

export function FlowChart({ weeks, sentence, id }: { weeks: Week[]; sentence: string; id: string }) {
  const label = flowLabel(weeks, sentence);
  return (
    <div className="vz-box" id={id} data-view="chart">
      <div className="vz-bar">
        <ul className="vz-legend">
          <li><svg width="28" height="12" aria-hidden="true"><line x1="0" y1="6" x2="20" y2="6" className="l-created" /><rect x="20" y="2" width="8" height="8" className="m-created" /></svg>Created</li>
          <li><svg width="28" height="12" aria-hidden="true"><line x1="0" y1="6" x2="20" y2="6" className="l-finished" /><rect x="20" y="3" width="7" height="7" className="m-finished" /></svg>Finished</li>
          <li><svg width="18" height="12" aria-hidden="true"><rect x="0" y="0" width="18" height="12" className="gap-fill" /></svg>Created minus finished</li>
          <li><svg width="28" height="12" aria-hidden="true"><line x1="0" y1="6" x2="28" y2="6" className="l-created l-dash" /></svg>Provisional week</li>
        </ul>
      </div>
      <div className="vz-plot">
        {VARIANTS.map(v => <Svg key={v.w} weeks={weeks} W={v.w} cls={v.cls} label={label} />)}
      </div>
      <div className="vz-tbl">
        <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Created and finished per week, table">
          <table className="tbl">
            <caption className="vh">Tickets created and finished per week. Net is created minus finished.</caption>
            <thead><tr><th scope="col">Week</th><th scope="col" className="n">Created</th><th scope="col" className="n">Finished</th><th scope="col" className="n">Net</th></tr></thead>
            <tbody>
              {weeks.map(w => (
                <tr key={w.key}><th scope="row">{w.short}{w.provisional ? " (prov.)" : ""}</th><td className="n">{w.created}</td><td className="n">{w.finished}</td><td className="n">{SIGN(w.net)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
