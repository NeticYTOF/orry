/* /me: My week, in three tabs (?tab=): Overview (your numbers, where you stand, open with you), Finished (the weekly chart
   and the tickets you finished) and Profile (the two switches). /me#profile and ?tab=profile both land on Profile.
   Layout: app/ui/stats.css (me-*, pd-*). */
import type { Metadata } from "next";
import Link from "next/link";
import { NavCount } from "@/components/board/NavCount";
import { readPrefs } from "@/components/shell/prefs-server";
import { SignOutEverywhere } from "@/components/shell/SignOutEverywhere";
import { ErrorState, TitleSide, weekNo } from "@/components/stats/common";
import { StandingStrip } from "@/components/stats/Podium";
import { PageHead } from "@/components/ui/PageHead";
import { pickTab, TabNav, type TabDef } from "@/components/ui/TabNav";
import { Tips } from "@/components/viz/Tips";
import { TrendChart } from "@/components/viz/TrendChart";
import { VizToggle } from "@/components/viz/VizToggle";
import { getMeModel, getRewardsModel } from "@/lib/models";
import { requireSession } from "@/lib/session";
import { LeaderboardSwitch, PeopleSwitch, ProfileHashRedirect } from "./Profile";

export const metadata: Metadata = { title: "My week" };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;
const TABS: TabDef[] = [{ key: "overview", label: "Overview" }, { key: "finished", label: "Finished" }, { key: "profile", label: "Profile" }];

export default async function MePage({ searchParams }: { searchParams: SP }) {
  const s = await requireSession("helper");
  const sp = await searchParams;
  const tab = pickTab(TABS, sp.tab);
  const [m, prefs, rw] = await Promise.all([getMeModel(s), readPrefs(), tab === "overview" ? getRewardsModel(s).catch(() => null) : null]);
  const wk = weekNo(m.week.label);
  const st = m.strip;
  const handle = m.profile.handle ?? `@${s.handle}`;
  const name = m.profile.name && m.profile.name !== handle.replace(/^@/, "") ? m.profile.name : null;

  return (
    <div id="top" className="pg-stats">
      {tab !== "profile" ? <ProfileHashRedirect /> : null}
      <PageHead
        kicker="My week"
        title={<><span className="vh">Your numbers: </span><span className="big">{m.error ? "?" : st.finished.value}</span> finished by you in week {wk}</>}
        side={<TitleSide chip={m.week.chip} freshness={m.freshness} what="Your numbers" />}
      />
      <TabNav label="My week sections" tabs={TABS} current={tab} href={k => (k === "overview" ? "/me" : `/me?tab=${k}`)} className="pg-tabs" />

      {tab === "overview" ? (
        m.error ? <ErrorState error={m.error} role={m.role} /> : (
          <>
            <dl className="stats" id="ledger" aria-label={`Your numbers for week ${wk}`}>
              <div className="stat">
                <dt className="stat-k">Finished by you</dt>
                <dd className="stat-v">{st.finished.value}</dd>
                <dd className="stat-s">{st.finished.line}</dd>
                {st.finished.compare ? <dd className="stat-s">{st.finished.compare}</dd> : null}
              </div>
              <div className="stat">
                <dt className="stat-k">Open with you now</dt>
                <dd className="stat-v">{st.open.value}</dd>
                <dd className="stat-s"><Link className="lnk" href="/board?view=mine">{st.open.line}</Link></dd>
                {st.open.sub ? <dd className="stat-s">{st.open.sub}</dd> : null}
              </div>
              <div className="stat">
                <dt className="stat-k">Median first reply</dt>
                <dd className={"stat-v" + (st.median.tooFew ? " sm" : "")}>{st.median.value}</dd>
                <dd className="stat-s">{st.median.team}</dd>
                {st.median.diff ? <dd className="stat-s">{st.median.diff}</dd> : null}
              </div>
              <div className="stat">
                <dt className="stat-k">Reopened after you</dt>
                <dd className="stat-v">{st.reopened.value}</dd>
                <dd className="stat-s">of {st.reopened.of} first replies</dd>
                <dd className="stat-s">{st.reopened.team}</dd>
              </div>
            </dl>

            {rw && !rw.error ? (
              <section className="sec" aria-labelledby="h-stand">
                <h2 className="sec-h" id="h-stand">Where you stand <Link className="sec-link" href="/rewards">All podiums{rw.leftText ? ` · ${rw.leftText} left` : ""} →</Link></h2>
                {rw.standing ? <StandingStrip items={rw.standing} inline /> : <p className="state-note">{rw.standingNote}</p>}
              </section>
            ) : null}

            <section className="sec" aria-labelledby="h-open">
              <div className="panel">
                <header className="panel-h"><h2 id="h-open">Open with you</h2><p className="sub">{m.openCaption}</p></header>
                <div className="panel-b tight">
                  <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Your open tickets">
                    <table className="tbl">
                      <thead><tr><th scope="col">Ticket</th><th scope="col">Status</th><th scope="col" className="n">Waiting</th></tr></thead>
                      <tbody>
                        {m.open.length ? m.open.map(o => (
                          <tr key={o.id}><th scope="row"><a href={o.href}>#{o.id}</a></th><td data-l="Status">{o.statusText} · {o.categoryLabel.toLowerCase()}</td><td className="n" data-l="Waiting"><time dateTime={o.waitIso}>{o.waitText}</time></td></tr>
                        )) : <tr><td colSpan={3} className="empty-note">Nothing is open with you right now.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </section>
          </>
        )
      ) : null}

      {tab === "finished" ? (
        m.error ? <ErrorState error={m.error} role={m.role} /> : (
          <>
            <section className="sec" aria-labelledby="h-trend">
              <div className="panel me-trend">
                <header className="panel-h">
                  <div><h2 id="h-trend">Finished per week</h2><p className="sub">{m.trend.caption}</p></div>
                  <div className="tools"><VizToggle target="trendViz" /></div>
                </header>
                <div className="panel-b">
                  <div className="me-trend-box">
                    <p className="me-sentence">{m.trend.sentence}</p>
                    <TrendChart weeks={m.trend.weeks} id="trendViz" />
                  </div>
                </div>
              </div>
            </section>

            <section className="sec" aria-labelledby="h-recent">
              <div className="panel">
                <header className="panel-h">
                  <div><h2 id="h-recent">Tickets you finished</h2><p className="sub">Week {wk} · newest first</p></div>
                  <div className="tools"><Link className="btn sm" href="/closed">All closed tickets</Link></div>
                </header>
                <div className="panel-b tight">
                  <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Tickets you finished">
                    <table className="tbl stack">
                      <thead><tr><th scope="col">Ticket</th><th scope="col">Question</th><th scope="col">Category</th><th scope="col">Closed</th><th scope="col" className="n">Took</th><th scope="col" className="n">First reply</th></tr></thead>
                      <tbody id="recent">
                        {m.finished.length ? m.finished.map(r => (
                          <tr key={r.id}>
                            <th scope="row"><a href={r.href}>#{r.id}</a></th>
                            <td className={"q" + (r.question == null ? " hid" : "")} data-l="Question">{r.question ?? <><span className="chip dash">Withheld</span> {r.questionNote}</>}</td>
                            <td data-l="Category">{r.categoryLabel}</td>
                            <td data-l="Closed">{r.closedText} UTC</td>
                            <td className="n" data-l="Took">{r.tookText}</td>
                            <td className="n" data-l="First reply">{r.firstReplyText ?? "None"}</td>
                          </tr>
                        )) : <tr><td colSpan={6} className="empty-note">You have not finished a ticket in week {wk} yet.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </section>
          </>
        )
      ) : null}

      {tab === "profile" ? (
        <section className="sec me-prof" id="profile" aria-labelledby="h-prof">
          <div className="panel">
            <header className="panel-h"><h2 id="h-prof">Profile</h2></header>
            <div className="panel-b me-prof-grid">
              <dl className="kv">
                <div><dt>Name</dt><dd id="pName">{name ? <><span className="pp-name">{name}</span><span className="pp-handle">Hidden while you show usernames only</span></> : "Slack has no display name for you"}</dd></div>
                <div><dt>Username</dt><dd>{handle}<small>Your Slack username. There is no separate site password.</small></dd></div>
                <div><dt>Role</dt><dd>{m.profile.roleText}</dd></div>
              </dl>
              <div className="me-switches">
                <div className="toggle-row">
                  <div><h3 id="t-lead">Show me on the leaderboard</h3><p>Off: you are left out of the rows and top cards. Team totals still count your tickets.</p></div>
                  <LeaderboardSwitch initial={m.profile.showOnLeaderboard} />
                </div>
                <div className="toggle-row">
                  <div><h3 id="t-names">Show people as</h3><p>Names with the @username underneath, or only @usernames. Applies to every page.</p></div>
                  <PeopleSwitch initial={prefs.people} />
                </div>
                <SignOutEverywhere />
              </div>
            </div>
          </div>
        </section>
      ) : null}
      <Tips />
      <NavCount session={s} />
    </div>
  );
}
