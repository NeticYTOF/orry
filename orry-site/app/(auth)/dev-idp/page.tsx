/* The dev identity provider's account chooser (local only). Shown when "Sign in with Hack Club" or an invite's
   "Continue" runs with no real Hack Club app configured. Pick an invented account to sign in as. */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { devAuthEnabled } from "@/lib/auth/config";
import { checkAuthorize, DEV_ACCOUNTS } from "@/lib/auth/dev-idp";
import { AuthCard } from "../AuthCard";

export const metadata: Metadata = { title: "Dev Hack Club (local)" };
export const dynamic = "force-dynamic";

const KEYS = ["client_id", "redirect_uri", "state", "nonce", "response_type"] as const;

export default async function DevIdpPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!devAuthEnabled()) notFound();
  const sp = await searchParams;
  const v = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const err = checkAuthorize({ clientId: v("client_id"), redirectUri: v("redirect_uri"), state: v("state"), nonce: v("nonce"), responseType: v("response_type") });
  const hidden = KEYS.map(k => <input key={k} type="hidden" name={k} value={v(k)} />);

  return (
    <AuthCard title="Dev Hack Club" wide>
      <section className="au-dev" aria-labelledby="dev-h">
        <h2 id="dev-h">Local only: not the real Hack Club</h2>
        {err ? <p className="state-note" role="alert">This sign-in request is not valid: {err}. Start again from the sign-in page.</p> : (
          <ul>
            {DEV_ACCOUNTS.map(a => (
              <li key={a.sub}>
                <form method="post" action="/dev-idp/authorize">
                  {hidden}
                  <input type="hidden" name="sub" value={a.sub} />
                  <button className="au-acct" type="submit">
                    <span>{a.name}</span>
                    <small>{a.slackId ? `@${a.handle} · Slack ${a.slackId}` : a.note}</small>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="au-alt">
        {err ? null : (
          <form method="post" action="/dev-idp/authorize">
            {hidden}
            <input type="hidden" name="deny" value="1" />
            <button className="btn" type="submit">Cancel</button>
          </form>
        )}
        <a className="lnk" href="/sign-in">Back to sign in</a>
      </div>
    </AuthCard>
  );
}
