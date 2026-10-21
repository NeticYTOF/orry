/* Sign in (PLAN 4.12, mockup #/signin): plain, no account, session ended, turned off, signed out, plus the
   few other outcomes of a sign-in. Invite only: there is no sign-up. */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DevPanel } from "@/components/shell/DevPanel";
import { devAuthEnabled } from "@/lib/auth/config";
import { primaryProviderId } from "@/lib/auth/providers";
import { getSession } from "@/lib/session";
import { AuthCard } from "../AuthCard";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const MSG: Record<string, string> = {
  noaccount: "This account has no access. Ask an organizer for an invite.",
  ended: "Your session ended. Sessions end after 12 hours without use, or after 7 days. Sign in again.",
  off: "An organizer turned this account off. Ask them if that is a mistake.",
  out: "You are signed out.",
  noslack: "Your Hack Club account has no linked Slack account, so the site can't check your helper status.",
  mismatch: "This Hack Club account is not the one this Slack account signed in with before, so you are not signed in. The organizers can see this in the access events.",
  retry: "That sign-in took too long or started in another tab. Try again.",
  failed: "The answer from Hack Club could not be checked, so you are not signed in. Try again.",
  cancelled: "Sign-in was cancelled.",
  unavailable: "Sign-in is not set up on this site yet. The operator needs to set the Hack Club client ID and secret.",
  exists: "You already have an account. Sign in as usual."
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const m = typeof sp.m === "string" ? sp.m : "";
  if (!m && (await getSession())) redirect("/board");
  const msg = MSG[m];
  const provider = primaryProviderId();

  return (
    <>
      <AuthCard title="Sign in">
        {msg ? <p id="authMsg" className="state-note" role="status">{msg}</p> : null}
        <form method="post" action="/api/auth/start">
          {provider ? <input type="hidden" name="provider" value={provider} /> : null}
          <button className="btn pri" type="submit" id="slackBtn" disabled={!provider}>Sign in with Hack Club</button>
        </form>
      </AuthCard>
      {devAuthEnabled() ? <DevPanel /> : null}
    </>
  );
}
