/* Team and invites (PLAN 7.6, mockup #/team). Organizers only. Four tabs that are real links (?tab=): Roster, Requests,
   Invites and Activity. Only the open tab is rendered. "Invite someone" and the row actions that need a confirmation are modals. */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageHead } from "@/components/ui/PageHead";
import { pickTab, TabNav, type TabDef } from "@/components/ui/TabNav";
import { Who } from "@/components/shell/Who";
import { recentEvents } from "@/lib/auth/events";
import { fmtDay, fmtRelative, fmtWhen } from "@/lib/auth/format";
import { peopleFor } from "@/lib/auth/roster";
import { listAccounts, listInvites, listPendingAccessRequests, shownState } from "@/lib/auth/store";
import { teamCounts } from "@/lib/auth/team";
import { now } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { AdminGate } from "./AdminGate";
import { eventSentence } from "./events";
import { AccessRequestActions, InviteModal, InviteRowActions, PersonRowActions } from "./TeamClient";

export const metadata: Metadata = { title: "Team and invites" };
export const dynamic = "force-dynamic";

/* State is a word plus a shape: filled = open, outlined = used, dashed = no longer works. */
const PILL: Record<string, ReactNode> = {
  pending: <span className="chip ac">Open</span>,
  expired: <span className="chip dash">Expired</span>,
  cancelled: <span className="chip dash">Cancelled</span>,
  used: <span className="chip">Used</span>
};

export default async function TeamPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const s = await requireSession("helper");
  if (s.role !== "organizer") return <AdminGate title="Team and invites" />;
  const sp = await searchParams;

  const t = now();
  const accounts = listAccounts();
  const requests = listPendingAccessRequests();
  const invites = listInvites(t - 30 * 86_400_000);
  const events = recentEvents(20);
  const c = teamCounts();
  const people = await peopleFor([
    ...accounts.map(a => a.slackId), ...requests.map(r => r.slackId), ...invites.map(i => i.slackId), ...invites.map(i => i.createdBy),
    ...events.map(e => e.actorSlackId), ...events.map(e => e.subjectSlackId)
  ]);
  const P = (id: string) => people.get(id) ?? { id, handle: id, name: id, known: false };

  const tabs: TabDef[] = [
    { key: "roster", label: "Roster", n: accounts.length },
    { key: "requests", label: "Requests", n: requests.length || null },
    { key: "invites", label: "Invites", n: c.openInvites || null },
    { key: "activity", label: "Activity" }
  ];
  const tab = pickTab(tabs, sp.tab);

  return (
    <div id="top" className="ad-page" tabIndex={-1}>
      <PageHead
        kicker="Organizers"
        title={<><span className="big">{c.canSignIn}</span> {c.canSignIn === 1 ? "person can" : "people can"} sign in</>}
        side={<>
          <TabNav label="Team sections" tabs={tabs} current={tab} href={k => `/team?tab=${k}`} />
          <InviteModal />
        </>}
      />

      <div className="stats" role="group" aria-label="Access numbers">
        <div className="stat"><span className="stat-k">Can sign in</span><span className="stat-v">{c.canSignIn}</span><span className="stat-s">{c.organizers} {c.organizers === 1 ? "organizer" : "organizers"}, {c.helpers} {c.helpers === 1 ? "helper" : "helpers"}</span></div>
        <div className="stat"><span className="stat-k">Open invites</span><span className="stat-v">{c.openInvites}</span></div>
        <div className="stat"><span className="stat-k">Turned off</span><span className="stat-v">{c.off}</span></div>
        <div className="stat"><span className="stat-k">Signed in today</span><span className="stat-v">{c.signedInToday}</span><span className="stat-s">of {c.canSignIn}</span></div>
      </div>

      {tab === "roster" ? (
        <section className="panel" aria-labelledby="h-ppl2">
          <div className="panel-h"><h2 id="h-ppl2">People</h2></div>
          <div className="panel-b tight">
            <div className="tbl-scroll" tabIndex={0} role="region" aria-label="People with access">
              <table className="tbl ad-tbl" id="pplTbl">
                <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Last sign-in</th><th scope="col">Access</th><th scope="col" className="ad-actcol"><span className="vh">Actions</span></th></tr></thead>
                <tbody>
                  {accounts.map(a => {
                    const you = a.slackId === s.slackId;
                    return (
                      <tr key={a.id} className={you ? "me" : undefined}>
                        <th scope="row"><Who p={P(a.slackId)} you={you} /></th>
                        <td>{a.role === "organizer" ? "Organizer" : "Helper"}</td>
                        <td>{a.hcaSub ? fmtWhen(a.lastSignInAt, t) : "Not yet"}</td>
                        <td>{a.status === "on" ? <span className="chip ac">On</span> : <span className="chip dash">Off</span>}</td>
                        <td>
                          <span className="ad-acts">
                            {you ? <span className="ad-dim">That is you</span> : <PersonRowActions id={a.id} role={a.role} on={a.status === "on"} label={P(a.slackId).known ? P(a.slackId).name : "@" + P(a.slackId).handle} />}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {tab === "requests" ? (
        <section className="panel" aria-labelledby="h-requests">
          <div className="panel-h"><h2 id="h-requests">Access requests</h2></div>
          <div className="panel-b tight">
            {requests.length === 0 ? <p className="empty-note">No pending access requests.</p> : (
              <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Pending access requests">
                <table className="tbl ad-tbl">
                  <thead><tr><th scope="col">Person</th><th scope="col">Requested</th><th scope="col" className="ad-actcol">Decision</th></tr></thead>
                  <tbody>{requests.map(r => (
                    <tr key={r.id}>
                      <th scope="row"><Who p={P(r.slackId)} /></th>
                      <td>{fmtWhen(r.createdAt, t)}</td>
                      <td><AccessRequestActions id={r.id} label={P(r.slackId).known ? P(r.slackId).name : "@" + P(r.slackId).handle} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      ) : null}

      {tab === "invites" ? (
        <section className="panel" aria-labelledby="h-inv2">
          <div className="panel-h"><h2 id="h-inv2">Invites</h2></div>
          <div className="panel-b tight">
            <div className="tbl-scroll" tabIndex={0} role="region" aria-label="Invites">
              <table className="tbl ad-tbl" id="invTbl">
                <thead><tr><th scope="col">For</th><th scope="col">Role</th><th scope="col">Sent by</th><th scope="col">Link</th><th scope="col">State</th><th scope="col" className="ad-actcol"><span className="vh">Actions</span></th></tr></thead>
                <tbody>
                  {invites.length === 0 ? <tr><td colSpan={6} className="empty-note">No invites in the last 30 days.</td></tr> : invites.map(v => {
                    const st = shownState(v, t);
                    const link = st === "pending" ? fmtRelative(v.expiresAt, t) : st === "expired" ? fmtRelative(v.expiresAt, t) : st === "cancelled" ? "Cancelled" : `Used ${v.usedAt ? fmtDay(v.usedAt) : ""}`;
                    const by = v.createdBy === "bootstrap" ? "Server (bootstrap)" : (P(v.createdBy).known ? P(v.createdBy).name : "@" + P(v.createdBy).handle);
                    return (
                      <tr key={v.id}>
                        <th scope="row"><Who p={P(v.slackId)} /></th>
                        <td>{v.role === "organizer" ? "Organizer" : "Helper"}</td>
                        <td>{by}</td>
                        <td>{link}</td>
                        <td>{PILL[st]}</td>
                        <td><span className="ad-acts"><InviteRowActions id={v.id} state={st} /></span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {tab === "activity" ? (
        <section className="panel" aria-labelledby="h-log">
          <div className="panel-h"><h2 id="h-log">Recent access events</h2></div>
          {events.length === 0 ? <div className="panel-b"><p className="ad-dim">No access events yet.</p></div> : (
            <ul className="ad-log" id="logList">
              {events.map(e => <li key={e.id}><time dateTime={new Date(e.at).toISOString()}>{fmtWhen(e.at, t)}</time><span>{eventSentence(e, people)}</span></li>)}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
