/* The board's "Queue shape": open tickets of the view by waiting time, one series, values at the bar ends, and a
   dashed rule where the site limit falls (mockups/queue.html renderQueueShape). Pure: the board passes its width.
   Text styles: .qs-* in app/ui/board.css. view="table" draws the same numbers as the kit's .tbl instead (the caller
   offers the switch; no fold). */

export function QueueShape({ buckets, viewLabel, limitText, width, view = "chart" }: { buckets: Array<{ label: string; n: number }>; viewLabel: string; limitText: string; width: number; view?: "chart" | "table" }) {
  const W = Math.max(280, Math.min(560, Math.floor(width) || 360));
  const L = 88, rh = 32, bw = W - L - 92, H = 8 + buckets.length * rh;
  const max = Math.max(1, ...buckets.map(b => b.n));
  const total = buckets.reduce((a, b) => a + b.n, 0);
  const ly = 8 + 2 * rh - 6;
  const label = `${viewLabel}, ${total} tickets by waiting time: ${buckets.map(b => `${b.label} ${b.n}`).join(", ")}. The site limit of ${limitText} falls between ${buckets[1]?.label ?? ""} and ${buckets[2]?.label ?? ""}.`;
  if (view === "table") {
    return (
      <div className="tbl-scroll qs-tbl">
        <table className="tbl">
          <caption className="vh">{viewLabel}: open tickets by waiting time. Limit {limitText}.</caption>
          <thead><tr><th scope="col">Waiting</th><th scope="col" className="n">Tickets</th></tr></thead>
          <tbody>{buckets.map(b => <tr key={b.label}><td>{b.label}</td><td className="n">{b.n}</td></tr>)}</tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="qs">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <line x1={L} y1="0" x2={L} y2={H - 4} stroke="var(--mut)" strokeWidth="1" />
        {buckets.map((b, i) => {
          const w = Math.max(b.n ? 4 : 0, Math.round((bw * b.n) / max));
          const y = 8 + i * rh;
          return (
            <g key={b.label}>
              <text className="qs-ax" x="0" y={y + 15}>{b.label}</text>
              <rect x={L} y={y} width={w} height="20" fill="var(--chart-a)" />
              <text className="qs-val" x={L + w + 8} y={y + 15}>{b.n}</text>
            </g>
          );
        })}
        <line x1={L - 6} y1={ly} x2={W} y2={ly} stroke="var(--ink)" strokeWidth="2" strokeDasharray="6 4" />
        <text className="qs-lim" x={W} y={ly - 5} textAnchor="end">Limit {limitText}</text>
      </svg>
    </div>
  );
}
