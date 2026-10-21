/* Pieces the Numbers pages share (Orry performance, Closed tickets, My week, Rewards): the header tags, the shared
   panel states (PLAN 4.0) and the pixel meter. Server-safe. Styles: kit.css (.fresh, .state, .mole, .meter) and
   app/ui/orry.css (.title-side). */
import type { Freshness, PanelError } from "@/lib/models";

/** The right end of the page header (PageHead side): the week chip ("Provisional until 25 Oct") and the freshness tag. */
export function TitleSide({ chip, freshness, what }: { chip: string | null; freshness: Freshness; what: string }) {
  const at = freshness.at ? freshness.at.slice(11, 16) : null;
  const tip = at ? `${what} computed ${at} UTC from Orry's ticket rows. Cached for 10 minutes.` : `${what}: no data from Orry yet.`;
  return (
    <div className="title-side">
      {chip ? <p className="fresh prov">{chip}</p> : null}
      <p className={"fresh" + (freshness.state !== "live" ? " stale" : "")} tabIndex={0} data-tip={tip}>{freshness.tag}</p>
    </div>
  );
}

/** Stale and offline banners (numbers stay visible). */
export function FreshBanner({ freshness }: { freshness: Freshness }) {
  if (!freshness.banner) return null;
  return <p className="stale-bar" role="status">{freshness.banner} These numbers may be out of date.</p>;
}

/** Not connected, needs an Orry update, offline with nothing to show, or an error. */
export function ErrorState({ error, role, id = "st-err" }: { error: PanelError; role: "helper" | "organizer"; id?: string }) {
  const away = error.kind === "not_connected" || error.kind === "unauthorized" || error.kind === "offline" || error.kind === "timeout";
  return (
    <section className={"state" + (away ? "" : " plain")} aria-labelledby={id} style={{ marginTop: 16 }}>
      {away ? <div className="mole away" aria-hidden="true" /> : null}
      <div>
        <h3 id={id}>{error.message}</h3>
        {error.detail ? <p>{error.detail}</p> : null}
        {error.gap ? <p>Needs Orry update {error.gap}.</p> : null}
        <div className="blk btn-row">
          {role === "organizer" ? <a className="btn pri" href="/config">Open config check</a> : null}
          {error.retry ? <a className="btn" href="">Try again</a> : null}
        </div>
      </div>
    </section>
  );
}

/** A calm empty week: Orry's sleeping pose. */
export function EmptyState({ title, body, id = "st-empty" }: { title: string; body?: string; id?: string }) {
  return (
    <section className="state" aria-labelledby={id} style={{ marginTop: 16 }}>
      <div className="mole sleeping" aria-hidden="true" />
      <div><h3 id={id}>{title}</h3>{body ? <p>{body}</p> : null}</div>
    </section>
  );
}

/** 20 cells of 5 %. */
export function Meter({ pct, label }: { pct: number; label: string }) {
  const on = Math.round(Math.max(0, Math.min(100, pct)) / 5);
  return <span className="meter" role="img" aria-label={label}>{Array.from({ length: 20 }, (_, i) => <i key={i} className={i < on ? "on" : undefined} />)}</span>;
}

/** "Week 42" -> "42". */
export const weekNo = (label: string): string => label.replace(/^Week\s+/, "");
