/* Team and invites (PLAN 7.6, decision L25): any organizer can invite and change roles, every change is an
   access event, and nobody can remove or turn off the last organizer. */
import { getDataSource } from "../data";
import { getDb, now, tx } from "../db";
import { INVITE_DAYS, INVITES_PER_DAY, OPEN_INVITES_MAX, SLACK_ID_RE } from "./config";
import { logEvent } from "./events";
import { rosterRole } from "./roster";
import {
  accountById, accountBySlack, cancelInviteRow, countActiveOrganizers, countInvitesBy, countOpenInvites, countOrganizerAccounts,
  deleteSessionsForAccount, insertAccount, insertInvite, inviteById, openInviteFor, type Role
} from "./store";

export class TeamError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = "TeamError"; }
}

export type Actor = { slackId: string; role: Role };

function mustOrganize(a: Actor) {
  if (a.role !== "organizer") throw new TeamError("forbidden", "Only organizers can do this.", 403);
}

export type CreatedInvite = { id: number; token: string; slackId: string; handle: string; role: Role; expiresAt: number; warning: string | null };

/** Creates an invite for a Slack username (or ID). The token is returned once and never stored. */
export async function createInvite(actor: Actor, input: { user: string; role: Role; days: number }): Promise<CreatedInvite> {
  mustOrganize(actor);
  if (!(INVITE_DAYS as readonly number[]).includes(input.days)) throw new TeamError("bad_days", "Pick 1, 7 or 30 days.");
  if (input.role !== "helper" && input.role !== "organizer") throw new TeamError("bad_role", "Pick helper or organizer.");
  const raw = input.user.trim();
  if (!raw) throw new TeamError("no_user", "Type a Slack username.");

  const ds = getDataSource();
  let person: { id: string; handle: string } | null = null;
  try {
    person = SLACK_ID_RE.test(raw) ? await ds.getSlackUser(raw) : await ds.findSlackUserByHandle(raw.replace(/^@/, "").toLowerCase());
  } catch {
    throw new TeamError("slack_unavailable", "Slack names can't be read right now, so the username can't be checked. Try again later.", 503);
  }
  if (!person) throw new TeamError("unknown_user", `There is no active Slack member called @${raw.replace(/^@/, "")}.`);
  if (!SLACK_ID_RE.test(person.id)) throw new TeamError("bad_slack_id", "That Slack account has an ID the site does not accept.");

  const existing = accountBySlack(person.id);
  if (existing?.status === "on") throw new TeamError("has_account", `@${person.handle} already has an account.`);
  if (existing?.status === "off") throw new TeamError("account_off", `@${person.handle} has an account that is turned off. Turn it on in People instead.`);
  if (openInviteFor(person.id)) throw new TeamError("has_invite", `@${person.handle} already has an open invite. Cancel it or use Send again.`);

  /* Warn, not block: the invite works only once they are on Orry's roster too (L23). */
  const r = await rosterRole(person.id);
  const warning = r === null
    ? "Orry could not be asked whether they are on the helper list. They need to be on it to get in."
    : r === "public" ? `@${person.handle} is not on Orry's helper list yet. The invite works, but they will not get in until they are on it.` : null;

  return tx(() => {
    if (countOpenInvites() >= OPEN_INVITES_MAX) throw new TeamError("too_many_open", `There are already ${OPEN_INVITES_MAX} open invites. Cancel some first.`, 429);
    if (countInvitesBy(actor.slackId, now() - 86_400_000) >= INVITES_PER_DAY) throw new TeamError("daily_limit", `You made ${INVITES_PER_DAY} invites in the last day. Try again tomorrow.`, 429);
    const { id, token } = insertInvite({ slackId: person!.id, role: input.role, createdBy: actor.slackId, days: input.days });
    logEvent("invite_created", actor.slackId, { subject: person!.id, reason: input.role });
    const inv = inviteById(id)!;
    return { id, token, slackId: person!.id, handle: person!.handle, role: input.role, expiresAt: inv.expiresAt, warning };
  });
}

export function cancelInvite(actor: Actor, id: number): void {
  mustOrganize(actor);
  tx(() => {
    const inv = inviteById(id);
    if (!inv) throw new TeamError("not_found", "That invite does not exist.", 404);
    if (!cancelInviteRow(id)) throw new TeamError("not_pending", "Only an open invite can be cancelled.");
    logEvent("invite_cancelled", actor.slackId, { subject: inv.slackId });
  });
}

/** "Send again": a new link for the same person and role. An open one is cancelled first, so only the new link works. */
export async function resendInvite(actor: Actor, id: number, days = 7): Promise<CreatedInvite> {
  mustOrganize(actor);
  const inv = inviteById(id);
  if (!inv) throw new TeamError("not_found", "That invite does not exist.", 404);
  if (inv.state === "used") throw new TeamError("used", "That invite was used. The person has an account.");
  const open = openInviteFor(inv.slackId);
  if (open) cancelInvite(actor, open.id);
  return createInvite(actor, { user: inv.slackId, role: inv.role, days });
}

/** The guard rail for the last organizer, inside the same transaction as the change. */
function wouldLeaveNoOrganizer(accountId: number): boolean {
  const a = accountById(accountId);
  if (!a || a.role !== "organizer" || a.status !== "on") return false;
  return countActiveOrganizers() <= 1;
}

export function setRole(actor: Actor, accountId: number, role: Role): void {
  mustOrganize(actor);
  if (role !== "helper" && role !== "organizer") throw new TeamError("bad_role", "Pick helper or organizer.");
  tx(() => {
    const a = accountById(accountId);
    if (!a) throw new TeamError("not_found", "That account does not exist.", 404);
    if (a.slackId === actor.slackId) throw new TeamError("self", "You can't change your own role. Ask another organizer.", 403);
    if (a.role === role) return;
    if (role === "helper" && wouldLeaveNoOrganizer(accountId)) throw new TeamError("last_organizer", "This is the last organizer. Make someone else an organizer first.", 409);
    getDb().prepare("UPDATE accounts SET role = ? WHERE id = ?").run(role, accountId);
    const n = deleteSessionsForAccount(accountId);
    logEvent("role_changed", actor.slackId, { subject: a.slackId, reason: `${a.role}_to_${role}` });
    if (n) logEvent("sessions_revoked", actor.slackId, { subject: a.slackId, reason: "role_changed" });
  });
}

export function setStatus(actor: Actor, accountId: number, status: "on" | "off"): void {
  mustOrganize(actor);
  tx(() => {
    const a = accountById(accountId);
    if (!a) throw new TeamError("not_found", "That account does not exist.", 404);
    if (a.slackId === actor.slackId) throw new TeamError("self", "You can't turn your own account off or on.", 403);
    if (a.status === status) return;
    if (status === "off" && wouldLeaveNoOrganizer(accountId)) throw new TeamError("last_organizer", "This is the last organizer. Make someone else an organizer first.", 409);
    getDb().prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, accountId);
    if (status === "off") {
      const n = deleteSessionsForAccount(accountId);
      logEvent("account_off", actor.slackId, { subject: a.slackId });
      if (n) logEvent("sessions_revoked", actor.slackId, { subject: a.slackId, reason: "account_off" });
    } else {
      logEvent("account_on", actor.slackId, { subject: a.slackId });
    }
  });
}

/** Signs one person out on every device (Settings: Sign out everywhere). */
export function signOutEverywhere(accountId: number, slackId: string): number {
  const n = deleteSessionsForAccount(accountId);
  logEvent("sessions_revoked", slackId, { subject: slackId, reason: "sign_out_everywhere" });
  return n;
}

/**
 * The first organizer (PLAN 7.6). Works only while no organizer account exists. Creates the account and a
 * single-use link (an organizer invite) that binds it to the Hack Club account at first sign-in.
 */
export function bootstrapOrganizer(slackId: string): { token: string; accountId: number } {
  if (!SLACK_ID_RE.test(slackId)) throw new TeamError("bad_slack_id", "That does not look like a Slack user ID (U or W, then 8 to 14 letters or digits).");
  return tx(() => {
    if (countOrganizerAccounts() > 0) throw new TeamError("organizer_exists", "An organizer account already exists. Ask an organizer to invite people from Team and invites.", 409);
    const existing = accountBySlack(slackId);
    let accountId: number;
    if (existing) {
      getDb().prepare("UPDATE accounts SET role = 'organizer', status = 'on' WHERE id = ?").run(existing.id);
      accountId = existing.id;
    } else {
      accountId = insertAccount({ slackId, hcaSub: null, role: "organizer", createdBy: "bootstrap" });
    }
    const { token } = insertInvite({ slackId, role: "organizer", createdBy: "bootstrap", days: 1 });
    logEvent("bootstrap", null, { subject: slackId });
    return { token, accountId };
  });
}

/** Counts for the Team page ledger and Config check. */
export function teamCounts() {
  const db = getDb();
  const one = (sql: string, ...a: Array<string | number>) => Number((db.prepare(sql).get(...a) as { n: number }).n);
  const dayStart = new Date(now()); dayStart.setUTCHours(0, 0, 0, 0);
  return {
    canSignIn: one("SELECT COUNT(*) AS n FROM accounts WHERE status = 'on' AND hca_sub IS NOT NULL"),
    organizers: one("SELECT COUNT(*) AS n FROM accounts WHERE status = 'on' AND role = 'organizer'"),
    helpers: one("SELECT COUNT(*) AS n FROM accounts WHERE status = 'on' AND role = 'helper'"),
    off: one("SELECT COUNT(*) AS n FROM accounts WHERE status = 'off'"),
    openInvites: countOpenInvites(),
    signedInToday: one("SELECT COUNT(*) AS n FROM accounts WHERE status = 'on' AND last_sign_in_at >= ?", dayStart.getTime())
  };
}
