/* /closed: every ticket finished in the week, and who finished it (PLAN 4.4, 4.17; mockups/orry.html #/closed). */
import type { Metadata } from "next";
import { NavCount } from "@/components/board/NavCount";
import { ClosedClient } from "@/components/stats/ClosedClient";
import { ErrorState, TitleSide, weekNo } from "@/components/stats/common";
import { PageHead } from "@/components/ui/PageHead";
import { Tips } from "@/components/viz/Tips";
import { getClosedModel, type ClosedBy } from "@/lib/models";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Closed tickets" };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const BY: ClosedBy[] = ["orry", "helper", "participant", "person"];

export default async function ClosedPage({ searchParams }: { searchParams: SP }) {
  const s = await requireSession("helper");
  const sp = await searchParams;
  const m = await getClosedModel(s, { week: one(sp.week) || null, includeImported: one(sp.imported) === "1" });
  const byQ = one(sp.by) === "self" ? "participant" : one(sp.by);
  const initial = {
    by: (BY.includes(byQ as ClosedBy) ? byQ : "all") as ClosedBy | "all",
    who: m.people.some(p => p.id === one(sp.who)) ? one(sp.who) : "",
    outcome: (one(sp.outcome) === "res" || one(sp.outcome) === "no" ? one(sp.outcome) : "") as "" | "res" | "no",
    q: one(sp.q).slice(0, 100)
  };

  return (
    <div id="top" className="pg-stats">
      {m.error ? (
        <>
          <PageHead
            kicker="Closed tickets"
            title={<><span className="vh">Closed tickets: </span><span className="big">?</span> closed in week {weekNo(m.week.label)}</>}
            side={<TitleSide chip={m.week.chip} freshness={m.freshness} what="Closed tickets" />}
          />
          <ErrorState error={m.error} role={s.role} />
        </>
      ) : (
        <>
          <ClosedClient key={m.week.key} m={m} initial={initial} imported={one(sp.imported) === "1"} />
        </>
      )}

      <Tips />
      <NavCount session={s} />
    </div>
  );
}
