/* No access (PLAN 2.2, 4.0 copy deck, 4.14): a calm static panel. Three cases:
   roster = signed in through Hack Club, but not on Loadout's helper list in Orry (no session is kept);
   offline = Orry cannot be asked about the roster, so helper access is paused;
   organizer = a helper opened an organizer page. */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { cookieNames } from "@/lib/auth/config";
import { decode } from "@/lib/auth/cookies";
import { personFor } from "@/lib/auth/roster";
import { getSession } from "@/lib/session";
import { AuthCard } from "../AuthCard";

export const metadata: Metadata = { title: "No access" };
export const dynamic = "force-dynamic";

export default async function NoAccessPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const m = typeof sp.m === "string" ? sp.m : "roster";
  const flash = decode.flash((await cookies()).get(cookieNames.flash)?.value);

  if (m === "organizer") {
    const s = await getSession();
    return (
      <AuthCard title="This page is for organizers">
        <p>{s ? `You are signed in as ${s.name !== s.handle ? s.name : "@" + s.handle}, a helper.` : "You are signed in as a helper."} Ask an organizer if you need something changed.</p>
        <a className="btn pri" href="/board">Back to the board</a>
      </AuthCard>
    );
  }

  if (m === "offline") {
    return (
      <AuthCard title="Orry is offline">
        <p className="state-note" role="status">Orry is offline, so helper access is paused. Organizers can still open Status.</p>
        <a className="btn pri" href="/sign-in">Back to sign in</a>
      </AuthCard>
    );
  }

  const who = flash?.sid ? await personFor(flash.sid) : null;
  const name = who ? (who.known && who.name !== who.handle ? who.name : "@" + who.handle) : null;
  return (
    <AuthCard title="This page is for Loadout helpers and organizers.">
      <p>
        {name ? <>You signed in as <b>{name}</b>. </> : null}
        You have an account here, but you are not on Loadout&apos;s helper list in Orry, so the site keeps you out. Ask an organizer.
      </p>
      <a className="btn pri" href="/sign-in">Back to sign in</a>
    </AuthCard>
  );
}
