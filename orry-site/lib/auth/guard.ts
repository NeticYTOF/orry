/* The one guard (PLAN 7.3). Pages, route handlers and the polling JSON routes all come through checkSession().
   Default deny: no valid session, an account that is off, or a person no longer on Orry's roster gets nothing. */
import { now } from "../db";
import { breakGlassIds, IDLE_MS, ROLE_GRACE_MS, ROLE_RECHECK_MS, TOUCH_MS } from "./config";
import { logEvent } from "./events";
import { personFor, rosterRole } from "./roster";
import { accountById, deleteSessionByHash, deleteSessionsForAccount, pruneSessions, sessionByToken, touchSession, type Role } from "./store";

export type { Role };
export type Session = { accountId: number; slackId: string; role: Role; handle: string; name: string };

export type Denied = "none" | "ended" | "off" | "roster" | "offline" | "forbidden";
export type CheckResult =
  | { ok: true; session: Session; roleStale: boolean }
  | { ok: false; reason: Denied; session?: Session };

const rank: Record<Role, number> = { helper: 1, organizer: 2 };
export const roleAtLeast = (have: Role, need: Role): boolean => rank[have] >= rank[need];

let lastPrune = 0;

/**
 * Checks a raw session ID from the cookie.
 * - min: the least role the route needs.
 * - path: the route being opened (only used for the break-glass rule: listed organizers can still open /config while Orry cannot be asked).
 */
export async function checkSession(raw: string | undefined | null, min: Role = "helper", path = ""): Promise<CheckResult> {
  if (!raw) return { ok: false, reason: "none" };
  const t = now();
  if (t - lastPrune > 10 * 60 * 1000) { lastPrune = t; pruneSessions(IDLE_MS); }

  const s = sessionByToken(raw);
  if (!s) return { ok: false, reason: "ended" };
  if (t >= s.expiresAt || t - s.lastSeenAt >= IDLE_MS) {
    deleteSessionByHash(s.idHash);
    return { ok: false, reason: "ended" };
  }
  const acct = accountById(s.accountId);
  if (!acct) { deleteSessionByHash(s.idHash); return { ok: false, reason: "ended" }; }
  if (acct.status !== "on") {
    deleteSessionsForAccount(acct.id);
    return { ok: false, reason: "off" };
  }

  /* The roster (second lock), re-checked every 5 minutes whatever the session says. */
  let roleStale = false;
  if (t - s.roleCheckedAt >= ROLE_RECHECK_MS) {
    const r = await rosterRole(acct.slackId);
    if (r === null) {
      if (t - s.roleCheckedAt >= ROLE_GRACE_MS) {
        const breakGlass = acct.role === "organizer" && breakGlassIds().includes(acct.slackId) && (path === "/config" || path.startsWith("/config/"));
        if (!breakGlass) return { ok: false, reason: "offline" };
      }
      roleStale = true;
    } else if (r === "public") {
      const n = deleteSessionsForAccount(acct.id);
      logEvent("sessions_revoked", null, { subject: acct.slackId, reason: `not_on_roster:${n}` });
      return { ok: false, reason: "roster" };
    } else {
      touchSession(s.idHash, { roleCheckedAt: t });
    }
  }
  if (t - s.lastSeenAt >= TOUCH_MS) touchSession(s.idHash, { lastSeenAt: t });

  const p = await personFor(acct.slackId);
  const session: Session = { accountId: acct.id, slackId: acct.slackId, role: acct.role, handle: p.handle, name: p.name };
  if (!roleAtLeast(acct.role, min)) return { ok: false, reason: "forbidden", session };
  return { ok: true, session, roleStale };
}

/** Where a page sends someone the guard turned away. */
export function deniedRedirect(reason: Denied): string {
  switch (reason) {
    case "none": return "/sign-in";
    case "ended": return "/sign-in?m=ended";
    case "off": return "/sign-in?m=off";
    case "roster": return "/no-access?m=roster";
    case "offline": return "/no-access?m=offline";
    case "forbidden": return "/no-access?m=organizer";
  }
}
