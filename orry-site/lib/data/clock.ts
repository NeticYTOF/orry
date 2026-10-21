/* The instant the data describes. Fixtures use a fixed instant so the pages are stable. */

/** Sunday of ISO week 42, 2026, 14:02 UTC: week 42 is "this week so far" and provisional, as in the mockups. */
export const DEFAULT_FIXTURE_NOW = Date.UTC(2026, 9, 18, 14, 2, 0);

/** ORRY_NOW (ISO string or ms) if set and valid, else the default fixture instant. */
export function fixtureNow(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORRY_NOW?.trim();
  if (!raw) return DEFAULT_FIXTURE_NOW;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(n) ? n : DEFAULT_FIXTURE_NOW;
}

/** The site's response limit L (decision 14.L4): ORRY_LIMIT_MINUTES, default 120. */
export function siteLimitMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ORRY_LIMIT_MINUTES);
  return Number.isFinite(n) && n >= 5 && n <= 7 * 24 * 60 ? Math.round(n) : 120;
}

/** Slack workspace subdomain for thread links (the bot hard-codes `hackclub`, lib/relatedThreads.ts:265-270). */
export function slackWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const w = (env.ORRY_SLACK_WORKSPACE ?? "hackclub").trim().toLowerCase();
  return /^[a-z0-9-]{1,40}$/.test(w) ? w : "hackclub";
}

/** `https://<workspace>.slack.com/archives/<channel>/p<thread_ts without the dot>`; null for DMs or bad input. */
export function slackThreadUrl(channel: string | null | undefined, threadTs: string | null | undefined, workspace = slackWorkspace()): string | null {
  if (!channel || !threadTs || !/^[CG][A-Z0-9]{2,}$/.test(channel) || !/^\d+\.\d+$/.test(threadTs)) return null;
  return `https://${workspace}.slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;
}
