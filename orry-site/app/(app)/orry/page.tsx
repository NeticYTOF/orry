/* /orry: how Orry is doing, for organizers. One ISO week. Four tabs that are real links (?tab=): Overview, Orry's answers,
   Waiting, Team; Overview and Waiting have a second row of sub-tabs (?sub=). Only the open view is rendered, with one or two
   panels. Every number and chart is drawn here on the server; the chart/table switch, the modal and the tooltips are the
   only browser code. The hour-by-hour medians open in a modal. (Was /stats for everyone.) CSS: app/ui/orry.css. */
import type { CSSProperties, ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { NavCount } from "@/components/board/NavCount";
import { WhoRef } from "@/components/board/people";
import { Modal } from "@/components/ui/Modal";
import { PageHead } from "@/components/ui/PageHead";
import { pickTab, TabNav, type TabDef } from "@/components/ui/TabNav";
import { EmptyState, ErrorState, FreshBanner, Meter, TitleSide, weekNo } from "@/components/stats/common";
import { ImportToggle } from "@/components/stats/ImportToggle";
import { FlowChart } from "@/components/viz/FlowChart";
import { Tips } from "@/components/viz/Tips";
import { VizToggle } from "@/components/viz/VizToggle";
import { WhoChart } from "@/components/viz/WhoChart";
import { getStatsModel, type StatsModel } from "@/lib/models";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Orry performance" };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;
const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const TABS: TabDef[] = [{ key: "overview", label: "Overview" }, { key: "answers", label: "Orry's answers" }, { key: "waiting", label: "Waiting" }, { key: "team", label: "Team" }];
const SUBS: Record<string, TabDef[]> = {
  overview: [{ key: "finished", label: "Finished" }, { key: "who", label: "Who finished" }, { key: "created", label: "Created" }],
  waiting: [{ key: "speed", label: "Speed" }, { key: "hours", label: "Busy hours" }]
};

/** "1 h 5 min" -> "1h05", "38 min" -> "38m" (the mockup's compact median table). */
function short(d: string): string {
  const s = d.replace(/ /g, " ");
  const m = s.match(/^(?:(\d+) d)?\s*(?:(\d+) h)?\s*(?:(\d+) min)?$/);
  if (!m) return s;
  const [, dd, hh, mm] = m;
  if (dd) return `${dd}d${hh ? hh + "h" : ""}`;
  if (hh) return `${hh}h${mm ? pad(Number(mm)) : ""}`;
  return `${mm ?? 0}m`;
}

/** The headline numbers: one strip of equal cells (a description list, so each number keeps its label). */
function Strip({ m, only }: { m: StatsModel; only: string[] }) {
  const prev = m.week.prev?.label.replace("W", "") ?? "";
  const cells = m.strip.filter(c => only.includes(c.key));
  return (
    <dl className="stats or-strip" id="ledger" style={{ "--cols": cells.length } as CSSProperties} aria-label={`${m.week.label} compared with week ${prev}`}>
      {cells.map(c => {
        const pct = c.key === "within" ? Number(c.value.replace(/[^\d]/g, "")) : null;
        const long = c.tooFew || c.value.length > 7;
        return (
          <div className="stat" key={c.key}>
            <dt className="stat-k">{c.label}</dt>
            <dd className={"stat-v" + (long ? " sm" : "") + (c.tooFew ? " few" : "")}>{c.value}</dd>
            {pct != null && !Number.isNaN(pct) && /\d/.test(c.value) ? (
              <dd className="or-meter"><Meter pct={pct} label={`${c.qualifier} ${c.label.toLowerCase()} (${c.value.replace(/ /g, " ")})`} /></dd>
            ) : null}
            <dd className="stat-s">{c.qualifier}</dd>
            {c.compare ? <dd className="stat-s or-cmp">{c.compare}</dd> : null}
          </div>
        );
      })}
    </dl>
  );
}

function Finished({ m }: { m: StatsModel }) {
  const fb = m.finishedBy, wk = weekNo(m.week.label);
  const parts: Array<{ cls: string; n: number }> = [
    { cls: "s-helper", n: fb.people.helpers }, { cls: "s-self", n: fb.people.participants }, { cls: "s-other", n: fb.people.personOrMacro },
    { cls: "s-orry", n: fb.orry.lastWord }, { cls: "s-orry", n: fb.orry.judge }, { cls: "s-orry", n: fb.orry.historyImport }
  ];
  const aria = `Of ${m.equation.finished} finished tickets: helpers ${fb.people.helpers}, participants ${fb.people.participants}, a person or macro ${fb.people.personOrMacro}, Orry last-word rule ${fb.orry.lastWord}, Orry judge ${fb.orry.judge}, history import ${fb.orry.historyImport}.`;
  const row = (cls: string, label: string, n: number) => <li><span><i className={"or-sw " + cls} aria-hidden="true" />{label}</span><b>{n}</b></li>;
  return (
    <section className="panel wide" aria-labelledby="h-finished">
      <header className="panel-h">
        <div className="or-ph"><h2 id="h-finished">How the {m.equation.finished} finished</h2><p className="sub">Week {wk} · {m.equation.resolved} resolved, {m.equation.closed} closed without resolution</p></div>
        <div className="tools"><Link className="btn sm" href={fb.ledgerHref}>See all {m.equation.finished}</Link></div>
      </header>
      <div className="panel-b">
        {m.equation.finished ? (
          <div className="or-split" role="img" aria-label={aria}>
            {parts.filter(p => p.n > 0).map((p, i) => <span key={i} className={"or-seg " + p.cls} style={{ flex: p.n }}><b>{p.n}</b></span>)}
          </div>
        ) : <p className="or-none">Nothing finished in week {wk}.</p>}
        <div className="or-key">
          <div><h3>Finished by people <b>{fb.people.total}</b></h3><ul>{row("s-helper", "Helpers", fb.people.helpers)}{row("s-self", "Participants themselves", fb.people.participants)}{row("s-other", "A person or macro", fb.people.personOrMacro)}</ul></div>
          <div><h3>Finished by Orry <b>{fb.orry.total}</b></h3><ul>{row("s-orry", "Last-word rule", fb.orry.lastWord)}{row("s-orry", "Judge", fb.orry.judge)}{row("s-orry", "History import", fb.orry.historyImport)}</ul></div>
        </div>
      </div>
    </section>
  );
}

function Team({ m }: { m: StatsModel }) {
  const t = m.team;
  return (
    <section className="panel wide" aria-labelledby="h-team">
      <header className="panel-h">
        <div className="or-ph"><h2 id="h-team">Team</h2><p className="sub" id="teamCohort">Week {weekNo(m.week.label)}</p></div>
        {t.rosterEmpty ? null : <div className="tools"><Link className="btn sm" href="/rewards">Weekly rewards</Link></div>}
      </header>
      <div className="panel-b tight" id="teamBody">
        {t.rosterEmpty ? (
          <div className="panel-b">
            <div className="state-note"><p><b>Empty because Loadout&apos;s helper roster is empty.</b></p><p>First human reply, the limit and the team need it.</p>{m.role === "organizer" ? <a className="btn sm" href="/team">Team and invites</a> : null}</div>
          </div>
        ) : (
          <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Team table">
            <table className="tbl">
              <thead><tr><th scope="col">Person</th><th scope="col" className="n">Finished</th><th scope="col" className="n">First replies</th><th scope="col" className="n">Median first reply</th><th scope="col" className="n">Reopened</th></tr></thead>
              <tbody>
                {t.rows.map(r => (
                  <tr key={r.person.id} className={r.person.you ? "me" : undefined}>
                    <th scope="row"><WhoRef p={r.person} /></th>
                    <td className="n">{r.finished}</td>
                    <td className="n">{r.firstReplies}</td>
                    <td className={"n" + (r.tooFew ? " few" : "")}>{r.median}</td>
                    <td className="n">{r.reopened}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><th scope="row">Team</th><td className="n">{t.totals.finished}</td><td className="n">{t.totals.firstReplies}</td><td className="n">{t.totals.median}</td><td className="n">{t.totals.reopened}</td></tr></tfoot>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Hours({ m }: { m: StatsModel }) {
  const h = m.heat;
  const cell = (d: number, b: number) => h.cells.find(c => c.day === d && c.block === b);
  const blocks = Array.from({ length: 12 }, (_, b) => b);
  const label = (b: number) => `${pad(b * 2)}:00-${pad(b * 2 + 2)}:00`;
  return (
    <section className="panel wide" aria-labelledby="h-wait">
      <header className="panel-h">
        <div className="or-ph"><h2 id="h-wait">When participants wait</h2><p className="sub">{h.weeksLabel}</p></div>
        <div className="tools">
          <Modal label="Median by hour" title="Median first reply per 2-hour block" wide>
            <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Median first human reply per 2-hour block, UTC">
              <table className="tbl med" id="medTbl">
                <caption className="vh">Median first human reply, UTC. 1h05 is 1 hour 5 minutes. A dash means fewer than 5 tickets.</caption>
                <thead><tr><th scope="col">Day</th>{blocks.map(b => <th scope="col" key={b}><span aria-hidden="true">{pad(b * 2)}</span><span className="vh">{label(b)}</span></th>)}</tr></thead>
                <tbody>
                  {DAYS.map((d, di) => (
                    <tr key={d}><th scope="row">{d}</th>{blocks.map(b => {
                      const c = cell(di, b);
                      return c && c.p90 != null ? <td key={b}>{short(c.median)}</td> : <td key={b}><span aria-hidden="true">-</span><span className="vh">fewer than 5 tickets</span></td>;
                    })}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Modal>
        </div>
      </header>
      <div className="panel-b">
        <div className="wg-wrap" tabIndex={0} role="region" aria-label="Tickets created per 2-hour block, last 4 weeks, UTC">
          <table className="wg" id="waitGrid">
            <caption className="vh">Tickets created per 2-hour block, last 4 weeks, UTC. {h.sentence}</caption>
            <thead><tr><th scope="col"><span className="vh">Day</span></th>{blocks.map(b => <th scope="col" key={b}><span aria-hidden="true">{pad(b * 2)}</span><span className="vh">{label(b)} UTC</span></th>)}</tr></thead>
            <tbody>
              {DAYS.map((d, di) => (
                <tr key={d}>
                  <th scope="row"><abbr title={cell(di, 0)?.dayLong ?? d}>{d}</abbr></th>
                  {blocks.map(b => {
                    const c = cell(di, b);
                    if (!c) return <td key={b} className="s0">0</td>;
                    return <td key={b} className={`s${c.step}`} data-tip={`<b>${c.dayLong} ${c.blockLabel} UTC</b><div class="tr"><span>Tickets created</span><b>${c.created}</b></div><div class="tr"><span>Needed a human</span><b>${c.neededHuman}</b></div><div class="tr"><span>Median first human reply</span><b>${c.median}</b></div>`}>{c.created}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="wg-legend" aria-label="Shade key">
          <li><i className="s0" aria-hidden="true" />0</li>
          <li><i className="s1" aria-hidden="true" />1-2</li>
          <li><i className="s2" aria-hidden="true" />3-4</li>
          <li><i className="s3" aria-hidden="true" />5-6</li>
          <li><i className="s4" aria-hidden="true" />7 or more tickets</li>
        </ul>
        <div className="wg-lists" id="waitLists">
          <div><h3>5 busiest blocks</h3><ol>{h.busiest.map(x => <li key={x.label}><span>{x.label}</span><b>{x.created} tickets</b></li>)}</ol></div>
          <div><h3>5 slowest blocks (n ≥ 5)</h3><ol>{h.slowest.length ? h.slowest.map(x => <li key={x.label}><span>{x.label}</span><b>{x.median} · n {x.n}</b></li>) : <li><span>No block has 5 or more tickets.</span></li>}</ol></div>
        </div>
      </div>
    </section>
  );
}

function Categories({ m }: { m: StatsModel }) {
  const sub = (t: string) => <span className="th-sub">{t}</span>;
  const a = m.categories.all;
  return (
    <section className="panel wide" aria-labelledby="h-cat">
      <header className="panel-h">
        <div className="or-ph"><h2 id="h-cat">By category</h2><p className="sub">Week {weekNo(m.week.label)}</p></div>
      </header>
      <div className="panel-b tight">
        <div className="tbl-scroll" tabIndex={0} role="region" aria-label="By category, table">
          <table className="tbl" id="catTbl">
            <thead><tr><th scope="col">Category</th><th scope="col" className="n">Created</th><th scope="col" className="n">First human reply{sub("median, created")}</th><th scope="col" className="n">Time to resolution{sub("median, finished")}</th><th scope="col" className="n">Reopened</th><th scope="col" className="n">Self-resolved</th></tr></thead>
            <tbody>
              {m.categories.rows.map(c => (
                <tr key={c.key}>
                  <th scope="row">{c.label}</th>
                  <td className="n">{c.created}</td>
                  {c.countsOnly
                    ? <td className="n few" colSpan={4}>{c.countsOnlyText}</td>
                    : <><td className="n">{c.firstReply}</td><td className="n">{c.resolution}</td><td className="n">{c.reopened}</td><td className="n">{c.selfResolved}</td></>}
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row">All</th><td className="n">{a.created}</td><td className="n">{a.firstReply}</td><td className="n">{a.resolution}</td><td className="n">{a.reopened}</td><td className="n">{a.selfResolved}</td></tr></tfoot>
          </table>
        </div>
      </div>
    </section>
  );
}

function Answers({ m }: { m: StatsModel }) {
  const cfg = m.role === "organizer" ? <> <a className="lnk" href="/team">Team and invites</a></> : null;
  const gate = <span className="or-gate">{m.answers.message}{cfg}</span>;
  const spr = (f: string) => <img className="or-spr" src={`/sprites/${f}.png`} alt="" width={32} height={32} />;
  return (
    <>
      <section className="panel wide" aria-labelledby="h-ans">
        <header className="panel-h">
          <div className="or-ph"><h2 id="h-ans">Orry&apos;s answers</h2><p className="sub">Last 7 days, not week {weekNo(m.week.label)}</p></div>
        </header>
        <div className="panel-b">
          <dl className="kv or-facts">
            <div><dt>{spr("ticket")}Answered</dt><dd>{gate}</dd></div>
            <div><dt>{spr("document")}Couldn&apos;t verify, didn&apos;t guess</dt><dd>{gate}</dd></div>
            <div><dt>{spr("people")}Escalated to a helper</dt><dd><span className="or-gate">Not available yet: Orry does not record handoffs.{cfg}</span></dd></div>
          </dl>
        </div>
      </section>
      <section className="panel wide" aria-labelledby="h-more">
        <header className="panel-h">
          <div className="or-ph"><h2 id="h-more">More measures</h2></div>
        </header>
        <div className="panel-b">
          <ul className="or-list">
            <li>{m.more.noHumanReply}. {m.more.noHumanNote}</li>
            {m.more.notAvailable.map(t => <li key={t}>{t}</li>)}
          </ul>
        </div>
      </section>
    </>
  );
}

function Chart({ id, title, sub, children }: { id: string; title: string; sub: string; children: ReactNode }) {
  return (
    <section className="panel wide" aria-labelledby={"h-" + id}>
      <header className="panel-h">
        <div className="or-ph"><h2 id={"h-" + id}>{title}</h2><p className="sub">{sub}</p></div>
        <div className="tools"><VizToggle target={"viz-" + id} /></div>
      </header>
      <div className="panel-b">{children}</div>
    </section>
  );
}

export default async function StatsPage({ searchParams }: { searchParams: SP }) {
  const s = await requireSession("organizer");
  const sp = await searchParams;
  const m = await getStatsModel(s, { week: typeof sp.week === "string" ? sp.week : null, includeImported: sp.imported === "1" });
  const wk = weekNo(m.week.label);
  const tab = pickTab(TABS, sp.tab);
  const subs = SUBS[tab];
  const sub = subs ? pickTab(subs, sp.sub) : "";
  const q = (key: string, week: string, subKey?: string) => `/orry?${new URLSearchParams({ ...(key === "overview" ? {} : { tab: key }), ...(subKey && SUBS[key] && subKey !== SUBS[key][0].key ? { sub: subKey } : {}), week, ...(m.includeImported ? { imported: "1" } : {}) })}`;
  const href = (week: string) => q(tab, week, sub);
  const orryN = m.finishedBy.orry.total;
  const pct = m.equation.finished ? Math.round((orryN / m.equation.finished) * 100) : 0;

  return (
    <div id="top" className="or-page">
      <PageHead
        kicker="Organizers"
        title={<><span className="vh">Orry performance: </span><span className="big">{m.error ? "?" : `${pct}%`}</span> of week <span className="num">{wk}</span> finished by Orry<span className="vh"> {m.week.year}</span></>}
        note={`${m.week.span} ${m.week.year}`}
        side={<TitleSide chip={m.week.chip} freshness={m.freshness} what="Orry performance" />}
      />

      <FreshBanner freshness={m.freshness} />
      <div className="or-bar" id="tools">
        {m.error ? <span /> : <TabNav label="Orry performance sections" tabs={TABS} current={tab} href={k => q(k, m.week.key)} className="or-tabs" />}
        <div className="or-ctl">
          <span className="vh" id="lbl-week">Week</span>
          <div className="or-week" role="group" aria-labelledby="lbl-week">
            {m.week.prev ? <Link className="btn sm" href={href(m.week.prev.key)} aria-label={`${m.week.prev.label}, previous week`}>‹ {m.week.prev.label}</Link> : null}
            <span className="or-wk" aria-current="date"><b>{m.week.label}{m.week.partial ? " so far" : ""}</b><small>{m.week.span}</small></span>
            {m.week.next ? <Link className="btn sm" href={href(m.week.next.key)} aria-label={`${m.week.next.label}, next week`}>{m.week.next.label} ›</Link> : null}
          </div>
          <span className="vh" id="lbl-coh">Created count</span>
          <ImportToggle on={m.includeImported} label={m.importToggle.label} week={m.week.key} />
        </div>
      </div>

      {m.error ? <ErrorState error={m.error} role={m.role} /> : (
        <>
          {subs ? <TabNav label={`${TABS.find(t => t.key === tab)?.label} views`} tabs={subs} current={sub} href={k => q(tab, m.week.key, k)} className="or-subtabs" /> : null}
          {m.incomplete ? <div className="state-note or-gap"><p>{m.incomplete}</p></div> : null}
          {m.empty && tab === "overview" && sub === "finished" ? <EmptyState title={m.empty} /> : null}

          <div className="or-pane">
            {tab === "overview" && sub === "finished" ? (
              <>
                <Strip m={m} only={["finished", "orry", "people", "created"]} />
                <div className="panel-grid or-grid tab-panel" id="tp-overview"><Finished m={m} /></div>
              </>
            ) : null}
            {tab === "overview" && sub === "who" ? (
              <div className="panel-grid or-grid tab-panel" id="tp-overview">
                <Chart id="who" title="Who finished tickets" sub={`Last ${m.whoChart.weeks.length} weeks · share of each week`}>
                  <WhoChart weeks={m.whoChart.weeks} id="viz-who" />
                </Chart>
              </div>
            ) : null}
            {tab === "overview" && sub === "created" ? (
              <div className="panel-grid or-grid tab-panel" id="tp-overview">
                <Chart id="flow" title="Created and finished per week" sub={`Last ${m.flowChart.weeks.length} weeks`}>
                  <FlowChart weeks={m.flowChart.weeks} sentence={m.flowChart.sentence} id="viz-flow" />
                </Chart>
              </div>
            ) : null}

            {tab === "answers" ? <div className="panel-grid or-grid tab-panel" id="tp-answers"><Answers m={m} /></div> : null}

            {tab === "waiting" && sub === "speed" ? (
              <>
                <Strip m={m} only={["first_reply", "resolution", "within", "reopened"]} />
                <div className="panel-grid or-grid tab-panel" id="tp-waiting"><Categories m={m} /></div>
              </>
            ) : null}
            {tab === "waiting" && sub === "hours" ? <div className="panel-grid or-grid tab-panel" id="tp-waiting"><Hours m={m} /></div> : null}

            {tab === "team" ? <div className="panel-grid or-grid tab-panel" id="tp-team"><Team m={m} /></div> : null}
          </div>
        </>
      )}
      <Tips />
      <NavCount session={s} />
    </div>
  );
}
