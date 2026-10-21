/* The invite (PLAN 7.6 step 2, mockup #/invite): valid, wrong account, expired, used, cancelled, and a link
   that matched nothing. The invite ID comes from the signed cookie set by /invite/<token>; the token never shows here. */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { decode } from "@/lib/auth/cookies";
import { cookieNames } from "@/lib/auth/config";
import { primaryProviderId } from "@/lib/auth/providers";
import { personFor } from "@/lib/auth/roster";
import { inviteById, shownState } from "@/lib/auth/store";
import { now } from "@/lib/db";
import { fmtUtc } from "@/lib/auth/format";
import { AuthCard } from "../AuthCard";

export const metadata: Metadata = { title: "Invite" };
export const dynamic = "force-dynamic";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <AuthCard title={title} bodyId="invBody">{children}</AuthCard>;
}

function Continue({ label, secondary }: { label: string; secondary?: boolean }) {
  const provider = primaryProviderId();
  return (
    <form method="post" action="/api/auth/start">
      <input type="hidden" name="invite" value="1" />
      {provider ? <input type="hidden" name="provider" value={provider} /> : null}
      <button className={"btn" + (secondary ? "" : " pri")} type="submit" disabled={!provider}>{label}</button>
    </form>
  );
}

const back = (label = "Back to sign in") => <a className="btn pri" href="/sign-in">{label}</a>;

export default async function InvitePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  if (sp.m === "slow") {
    return <Card title="Too many tries"><p>Too many invite links were opened in the last minute. Wait a minute and open yours again.</p>{back()}</Card>;
  }
  const c = decode.invite((await cookies()).get(cookieNames.invite)?.value);
  const inv = c && c.i ? inviteById(c.i) : null;
  if (!inv) {
    return (
      <Card title="This link does not work">
        <p>It is not an invite this site knows, or it was opened more than 10 minutes ago. Open the link from your message again, or ask the organizer for a new one.</p>
        {back()}
      </Card>
    );
  }

  const state = shownState(inv, now());
  const [who, by] = await Promise.all([personFor(inv.slackId), inv.createdBy === "bootstrap" ? null : personFor(inv.createdBy)]);
  const byName = by ? (by.known ? by.name : "@" + by.handle) : "The site owner";

  if (state === "expired") {
    return <Card title="This invite expired"><p>It ran out on {fmtUtc(inv.expiresAt)}. Ask the organizer who sent it for a new one.</p>{back()}</Card>;
  }
  if (state === "used") {
    return <Card title="This invite was used"><p>Someone already signed in with it. If that was you, sign in as usual.</p>{back("Go to sign in")}</Card>;
  }
  if (state === "cancelled") {
    return <Card title="This invite was cancelled"><p>An organizer cancelled it. Ask them for a new one if you still need access.</p>{back()}</Card>;
  }
  if (c?.w) {
    const wrong = await personFor(c.w);
    return (
      <Card title="Wrong Slack account">
        <p className="state-note">Your Hack Club account is linked to <b>@{wrong.handle}</b>. This invite is for <b>@{who.handle}</b>.</p>
        <Continue label="Try again" />
      </Card>
    );
  }
  return (
    <Card title="You are invited">
      <dl className="kv au-facts">
        <div><dt>Invited by</dt><dd>{byName}</dd></div>
        <div><dt>Role</dt><dd>{inv.role === "organizer" ? "Organizer" : "Helper"}</dd></div>
        <div><dt>For Slack account</dt><dd>@{who.handle}</dd></div>
        <div><dt>Link works until</dt><dd>{fmtUtc(inv.expiresAt)}</dd></div>
      </dl>
      <Continue label="Continue with Hack Club" />
    </Card>
  );
}
