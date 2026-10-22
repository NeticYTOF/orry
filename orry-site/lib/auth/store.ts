/* Rows in site.db: accounts, sessions and invites. Session IDs and invite tokens are stored only as SHA-256 hashes. */
import { getDb, now, tx } from "../db";
import { randomToken, sha256 } from "./crypto";
import { ABSOLUTE_MS } from "./config";

export type Role = "helper" | "organizer";
export type Account = {
  id: number; slackId: string; hcaSub: string | null; role: Role; status: "on" | "off";
  createdAt: number; createdBy: string | null; lastSignInAt: number | null;
};
export type InviteState = "pending" | "used" | "cancelled";
export type Invite = {
  id: number; slackId: string; role: Role; createdBy: string; createdAt: number; expiresAt: number;
  state: InviteState; usedAt: number | null;
};
/** The state people see: "expired" is computed from expires_at, never stored. */
export type InviteShownState = InviteState | "expired";

type AccountRow = { id: number; slack_id: string; hca_sub: string | null; role: Role; status: "on" | "off"; created_at: number; created_by: string | null; last_sign_in_at: number | null };
type InviteRow = { id: number; slack_id: string; role: Role; created_by: string; created_at: number; expires_at: number; state: InviteState; used_at: number | null };

const toAccount = (r: AccountRow | undefined): Account | null => r ? {
  id: r.id, slackId: r.slack_id, hcaSub: r.hca_sub, role: r.role, status: r.status,
  createdAt: r.created_at, createdBy: r.created_by, lastSignInAt: r.last_sign_in_at
} : null;
const toInvite = (r: InviteRow | undefined): Invite | null => r ? {
  id: r.id, slackId: r.slack_id, role: r.role, createdBy: r.created_by, createdAt: r.created_at,
  expiresAt: r.expires_at, state: r.state, usedAt: r.used_at
} : null;

/* ---------------- accounts ---------------- */

export function accountBySlack(slackId: string): Account | null {
  return toAccount(getDb().prepare("SELECT * FROM accounts WHERE slack_id = ?").get(slackId) as AccountRow | undefined);
}
export function accountBySub(sub: string): Account | null {
  return toAccount(getDb().prepare("SELECT * FROM accounts WHERE hca_sub = ?").get(sub) as AccountRow | undefined);
}
export function accountById(id: number): Account | null {
  return toAccount(getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined);
}
export function listAccounts(): Account[] {
  return (getDb().prepare("SELECT * FROM accounts ORDER BY CASE role WHEN 'organizer' THEN 0 ELSE 1 END, COALESCE(last_sign_in_at, 0) DESC, id").all() as AccountRow[]).map(r => toAccount(r)!);
}
export function countActiveOrganizers(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'organizer' AND status = 'on'").get() as { n: number }).n);
}
export function countOrganizerAccounts(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'organizer'").get() as { n: number }).n);
}
export function insertAccount(a: { slackId: string; hcaSub: string | null; role: Role; status?: "on" | "off"; createdBy: string | null; createdAt?: number; lastSignInAt?: number | null }): number {
  const r = getDb().prepare("INSERT INTO accounts (slack_id, hca_sub, role, status, created_at, created_by, last_sign_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(a.slackId, a.hcaSub, a.role, a.status ?? "on", a.createdAt ?? now(), a.createdBy, a.lastSignInAt ?? null);
  return Number(r.lastInsertRowid);
}

/* ---------------- sessions ---------------- */

export type SessionRow = { idHash: string; accountId: number; createdAt: number; lastSeenAt: number; expiresAt: number; roleCheckedAt: number };

/** Makes a new session and returns the raw ID for the cookie. Only its hash is stored. */
export function createSession(accountId: number, roleCheckedAt = now()): string {
  const raw = randomToken(32);
  const t = now();
  getDb().prepare("INSERT INTO sessions (id_hash, account_id, created_at, last_seen_at, expires_at, role_checked_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sha256(raw), accountId, t, t, t + ABSOLUTE_MS, roleCheckedAt);
  return raw;
}
export function sessionByToken(raw: string): SessionRow | null {
  const r = getDb().prepare("SELECT * FROM sessions WHERE id_hash = ?").get(sha256(raw)) as
    { id_hash: string; account_id: number; created_at: number; last_seen_at: number; expires_at: number; role_checked_at: number } | undefined;
  return r ? { idHash: r.id_hash, accountId: r.account_id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, roleCheckedAt: r.role_checked_at } : null;
}
export function deleteSessionByToken(raw: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(raw));
}
export function deleteSessionByHash(idHash: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
}
export function deleteSessionsForAccount(accountId: number): number {
  return Number(getDb().prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId).changes);
}
export function touchSession(idHash: string, fields: { lastSeenAt?: number; roleCheckedAt?: number }): void {
  if (fields.lastSeenAt !== undefined) getDb().prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(fields.lastSeenAt, idHash);
  if (fields.roleCheckedAt !== undefined) getDb().prepare("UPDATE sessions SET role_checked_at = ? WHERE id_hash = ?").run(fields.roleCheckedAt, idHash);
}
export function pruneSessions(idleMs: number): void {
  const t = now();
  getDb().prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?").run(t, t - idleMs);
}
export function sessionCount(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n);
}

/* ---------------- invites ---------------- */

export function inviteById(id: number): Invite | null {
  return toInvite(getDb().prepare("SELECT * FROM invites WHERE id = ?").get(id) as InviteRow | undefined);
}
export function inviteByToken(raw: string): Invite | null {
  return toInvite(getDb().prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(raw)) as InviteRow | undefined);
}
export function shownState(inv: Invite, t = now()): InviteShownState {
  return inv.state === "pending" && inv.expiresAt <= t ? "expired" : inv.state;
}
export function insertInvite(i: { slackId: string; role: Role; createdBy: string; days: number; createdAt?: number }): { id: number; token: string } {
  const token = randomToken(32);
  const t = i.createdAt ?? now();
  const r = getDb().prepare("INSERT INTO invites (token_hash, slack_id, role, created_by, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
    .run(sha256(token), i.slackId, i.role, i.createdBy, t, t + i.days * 86_400_000);
  return { id: Number(r.lastInsertRowid), token };
}
export function listInvites(sinceMs: number): Invite[] {
  return (getDb().prepare("SELECT * FROM invites WHERE created_at >= ? OR state = 'pending' ORDER BY created_at DESC, id DESC").all(sinceMs) as InviteRow[]).map(r => toInvite(r)!);
}
export function countOpenInvites(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM invites WHERE state = 'pending' AND expires_at > ?").get(now()) as { n: number }).n);
}
export function countInvitesBy(slackId: string, sinceMs: number): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND created_at >= ?").get(slackId, sinceMs) as { n: number }).n);
}
export function openInviteFor(slackId: string): Invite | null {
  return toInvite(getDb().prepare("SELECT * FROM invites WHERE slack_id = ? AND state = 'pending' AND expires_at > ? ORDER BY id DESC LIMIT 1").get(slackId, now()) as InviteRow | undefined);
}
/** Marks the invite used only if it is still pending and unexpired. Returns true when this call used it. */
export function claimInvite(id: number): boolean {
  const t = now();
  return Number(getDb().prepare("UPDATE invites SET state = 'used', used_at = ? WHERE id = ? AND state = 'pending' AND expires_at > ?").run(t, id, t).changes) === 1;
}
export function cancelInviteRow(id: number): boolean {
  return Number(getDb().prepare("UPDATE invites SET state = 'cancelled' WHERE id = ? AND state = 'pending'").run(id).changes) === 1;
}

export { tx };
