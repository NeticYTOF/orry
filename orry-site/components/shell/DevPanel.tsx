/* The dev sign-in panel on /sign-in. Local only: it exists only when ORRY_DEV_AUTH=1, and it stands in for
   Hack Club with invented accounts. Each button starts a normal sign-in through the dev identity provider. */
import { DEV_ACCOUNTS } from "@/lib/auth/dev-idp";
import { accountBySlack, openInviteFor } from "@/lib/auth/store";

function label(slackId: string | null): string {
  if (!slackId) return "no Slack link";
  const a = accountBySlack(slackId);
  if (a) return a.status === "off" ? "turned off" : a.role;
  return openInviteFor(slackId) ? "invited, no account yet" : "no account";
}

export function DevPanel() {
  return (
    <section className="panel flat au-dev au-dev-box" aria-labelledby="dev-h">
      <h2 id="dev-h">Local only: dev sign-in</h2>
      <ul>
        {DEV_ACCOUNTS.map(a => (
          <li key={a.sub}>
            <form method="post" action="/api/auth/start">
              <input type="hidden" name="provider" value="dev" />
              <input type="hidden" name="as" value={a.sub} />
              <button className="au-acct" type="submit">
                <span>{a.name}</span>
                <small>{a.handle ? `@${a.handle} · ${label(a.slackId)}` : a.note}</small>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
