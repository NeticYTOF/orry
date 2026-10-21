/* /rewards: the weekly podiums, in three tabs (?tab=): this week (where you stand and the four podiums), last week's
   winners, and the full ranking with the week-by-week table. Layout: app/ui/stats.css (pd-*). */
import type { Metadata } from "next";
import { NavCount } from "@/components/board/NavCount";
import { WhoRef } from "@/components/board/people";
import { ErrorState, FreshBanner } from "@/components/stats/common";
import { LeaderboardClient, type Measure } from "@/components/stats/LeaderboardClient";
import { PodiumCard, StandingStrip } from "@/components/stats/Podium";
import { PageHead } from "@/components/ui/PageHead";
import { pickTab, TabNav, type TabDef } from "@/components/ui/TabNav";
import { Tips } from "@/components/viz/Tips";
import { getLeaderboardModel, getRewardsModel } from "@/lib/models";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Weekly rewards" };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

const TABS: TabDef[] = [{ key: "week", label: "This week" }, { key: "last", label: "Last week" }, { key: "ranking", label: "Full ranking" }];

export default async function RewardsPage({ searchParams }: { searchParams: SP }) {
  const s = await requireSession("helper");
  const sp = await searchParams;
  const tab = pickTab(TABS, sp.tab);
  const [m, lb] = await Promise.all([getRewardsModel(s), tab === "ranking" ? getLeaderboardModel(s, { period: one(sp.period) || null }) : null]);
  const measure: Measure = one(sp.measure) === "med" ? "med" : one(sp.measure) === "re" ? "re" : "fin";
  const wk = m.week.label.replace(/^Week\s+/, "");

  return (
    <div id="top" className="pg-stats">
      <PageHead
        kicker="Weekly rewards"
        title={<><span className="vh">Weekly rewards: </span>{m.leftText ? <><span className="big">{m.leftText}</span> left in week {wk}</> : <>Week {wk} <span className="vh">final</span> podiums</>}</>}
        side={<p className="fresh prov">{m.error ? "No data" : m.closesText}</p>}
      />

      <FreshBanner freshness={m.freshness} />
      {m.error ? <ErrorState error={m.error} role={s.role} /> : (
        <>
          <TabNav label="Weekly rewards sections" tabs={TABS} current={tab} href={k => `/rewards?tab=${k}`} className="pg-tabs" />

          {tab === "week" ? (
            <>
              {m.standing ? (
                <section className="sec" aria-labelledby="h-stand">
                  <h2 className="sec-h" id="h-stand">Where you stand</h2>
                  <StandingStrip items={m.standing} />
                </section>
              ) : m.standingNote ? <p className="state-note">{m.standingNote}</p> : null}

              <section className="sec" aria-labelledby="h-pod">
                <h2 className="sec-h" id="h-pod">This week&apos;s podiums <span className="sub">{m.week.label} · {m.week.span}</span></h2>
                <div className="pd-grid">{m.podiums.map(p => <PodiumCard key={p.key} p={p} />)}</div>
              </section>
            </>
          ) : null}

          {tab === "last" ? (
            m.last ? (
              <section className="sec" aria-labelledby="h-last">
                <h2 className="sec-h" id="h-last">Last week&apos;s winners <span className="sub">{m.last.label}{m.last.provisionalNote ? ` · ${m.last.provisionalNote}` : ""}</span></h2>
                <div className="pd-grid">{m.last.podiums.map(p => <PodiumCard key={p.key} p={p} last />)}</div>
              </section>
            ) : <p className="state-note">There is no earlier week to show yet.</p>
          ) : null}

          {tab === "ranking" && lb ? (
            <>
              <section className="sec" aria-labelledby="h-rank">
                <h2 className="sec-h" id="h-rank">Ranking</h2>
                <LeaderboardClient m={lb} measure={measure} base="/rewards" keep={{ tab: "ranking" }} />
              </section>
              <section className="sec" aria-labelledby="h-mx">
                <h2 className="sec-h" id="h-mx">Week by week</h2>
                <div className="tbl-wrap">
                  <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Finished per person per week">
                    <table className="tbl pd-matrix" id="mx">
                      <caption className="vh">Tickets finished per person, week by week</caption>
                      <thead><tr><th scope="col">Person</th>{lb.matrix.weeks.map(w => <th scope="col" className="n" key={w.key}>{w.short}</th>)}<th scope="col" className="n">Total</th></tr></thead>
                      <tbody>
                        {lb.matrix.rows.map(r => (
                          <tr key={r.person.id} className={r.you ? "me" : undefined}>
                            <th scope="row"><WhoRef p={r.person} you={r.you} /></th>
                            {r.values.map((v, i) => <td className="n" key={i}>{v}</td>)}
                            <td className="n"><b>{r.total}</b></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr><th scope="row">Team</th>{lb.matrix.team.values.map((v, i) => <td className="n" key={i}>{v}</td>)}<td className="n"><b>{lb.matrix.team.total}</b></td></tr></tfoot>
                    </table>
                  </div>
                </div>
              </section>
            </>
          ) : null}
        </>
      )}
      <Tips />
      <NavCount session={s} />
    </div>
  );
}
