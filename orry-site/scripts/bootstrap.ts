/* npm run bootstrap -- <slack-id>
   Makes the first organizer account and prints a single-use sign-in link for it (PLAN 7.6).
   Refuses once any organizer account exists. Run it on the server, never from the site. */
import { baseUrl } from "../lib/auth/config";
import { bootstrapOrganizer, TeamError } from "../lib/auth/team";

const slackId = (process.argv[2] || "").trim();
if (!slackId) {
  console.error("Usage: npm run bootstrap -- <slack-user-id>   (for example U0123456789)");
  process.exit(2);
}
try {
  const { token } = bootstrapOrganizer(slackId);
  console.log(`Organizer account made for ${slackId}.`);
  console.log("Open this link and sign in with the Hack Club account linked to that Slack user.");
  console.log("It works once, within 1 day:");
  console.log(`  ${baseUrl()}/invite/${token}`);
} catch (e) {
  console.error(e instanceof TeamError ? e.message : "Bootstrap failed: " + (e as Error).message);
  process.exit(1);
}
