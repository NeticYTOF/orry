/* Access events (PLAN 7.6): who signed in, who was refused, every invite and role change.
   No IP addresses and no message text. Kept 90 days. */
import { getDb, now } from "../db";

export const EVENT_KINDS = [
  "invite_created", "invite_cancelled", "invite_used",
  "sign_in", "sign_in_refused", "sign_out",
  "account_off", "account_on", "role_changed", "sessions_revoked",
  "bootstrap", "ticket_view", "ticket_reveal"
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_RETENTION_DAYS = 90;

export type AccessEvent = {
  id: number; at: number; kind: string;
  actorSlackId: string | null; subjectSlackId: string | null; reason: string | null;
};

/* Reasons are short machine labels, never free text from a person. */
const REASON = /^[a-z0-9_:.\- ]{0,80}$/i;

export function logEvent(kind: string, actorSlackId: string | null, o: { subject?: string; reason?: string } = {}): void {
  const reason = o.reason && REASON.test(o.reason) ? o.reason : o.reason ? "other" : null;
  getDb()
    .prepare("INSERT INTO access_events (at, actor_slack_id, kind, subject_slack_id, reason) VALUES (?, ?, ?, ?, ?)")
    .run(now(), actorSlackId, kind, o.subject ?? null, reason);
}

export function recentEvents(limit = 50): AccessEvent[] {
  pruneEvents();
  const rows = getDb()
    .prepare("SELECT id, at, kind, actor_slack_id, subject_slack_id, reason FROM access_events ORDER BY at DESC, id DESC LIMIT ?")
    .all(limit) as Array<{ id: number; at: number; kind: string; actor_slack_id: string | null; subject_slack_id: string | null; reason: string | null }>;
  return rows.map(r => ({ id: r.id, at: r.at, kind: r.kind, actorSlackId: r.actor_slack_id, subjectSlackId: r.subject_slack_id, reason: r.reason }));
}

let lastPrune = 0;
export function pruneEvents(): void {
  const t = now();
  if (t - lastPrune < 60 * 60 * 1000) return;
  lastPrune = t;
  getDb().prepare("DELETE FROM access_events WHERE at < ?").run(t - EVENT_RETENTION_DAYS * 86_400_000);
}
