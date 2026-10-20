// One row per message the answer pipeline handled: what Orry finally did
// with it and why. Metadata only: no message text and no user id, so the
// table can be read by a status site and kept for a year.
import db = require("./db");
import log = require("./log");

const SAFE = /^[A-Za-z0-9_.:-]{1,64}$/;
const LIST_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface Location {
  channel?: string | null;
  threadTs?: string | null;
  messageTs?: string | null;
}

interface PipelineEvent {
  program_id?: unknown;
  channel_role?: unknown;
  addressed?: unknown;
  grounding_pass?: unknown;
  final_action?: unknown;
  reason?: unknown;
  latency_ms?: unknown;
}

interface OutcomeRow {
  id: number;
  channel: string | null;
  thread_ts: string | null;
  message_ts: string | null;
  ticket_id: number | null;
  channel_role: string | null;
  addressed: number;
  final_action: string;
  reason: string | null;
  grounded: number | null;
  latency_ms: number | null;
  created_at: number;
}

function safe(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return SAFE.test(s) ? s : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ticketFor(channel: string | null, threadTs: string | null): number | null {
  if (!channel || !threadTs) return null;
  const row = db
    .handle()
    .query("SELECT id FROM tickets WHERE channel = ? AND thread_ts = ? LIMIT 1")
    .get(channel, threadTs) as { id: number } | null;
  return row ? row.id : null;
}

// Called once per finished pipeline trace. Never throws.
function record(event: PipelineEvent, where: Location = {}): void {
  try {
    const action = safe(event.final_action);
    if (!action) return;
    const channel = safe(where.channel);
    const threadTs = safe(where.threadTs);
    const grounded = typeof event.grounding_pass === "boolean" ? (event.grounding_pass ? 1 : 0) : null;
    const latency = Number(event.latency_ms);
    db.handle()
      .query(
        `INSERT INTO answer_outcomes (program_id, channel, thread_ts, message_ts, ticket_id, channel_role, addressed,
           final_action, reason, grounded, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        safe(event.program_id),
        channel,
        threadTs,
        safe(where.messageTs),
        ticketFor(channel, threadTs),
        safe(event.channel_role),
        event.addressed ? 1 : 0,
        action,
        safe(event.reason),
        grounded,
        Number.isFinite(latency) ? Math.max(0, Math.round(latency)) : null,
        Date.now(),
      );
  } catch (e: unknown) {
    log.debug("answerOutcomes", `outcome not recorded: ${errorMessage(e)}`);
  }
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

// Program-scoped, newest first, with counts by final action and reason for
// the whole window (not just the page) so a funnel adds up.
function listForProgram(
  programId: string,
  params: {
    since?: string | number | null;
    until?: string | number | null;
    limit?: string | number | null;
    offset?: string | number | null;
  } = {},
) {
  if (!programId || !require("./programs").get(programId)) return { error: "unknown program" };
  const until = present(params.until) ? Number(params.until) : Date.now();
  const since = present(params.since) ? Number(params.since) : until - LIST_DEFAULT_WINDOW_MS;
  if (!Number.isFinite(since) || !Number.isFinite(until))
    return { error: "since and until must be epoch milliseconds" };
  if (since >= until) return { error: "since must be before until" };
  const limit = Math.min(Math.max(Math.trunc(Number(params.limit)) || 100, 1), 500);
  const offset = Math.max(Math.trunc(Number(params.offset)) || 0, 0);
  const where = "program_id = ? AND created_at > ? AND created_at <= ?";
  const handle = db.handle();
  const groups = handle
    .query(
      `SELECT final_action, reason, COUNT(*) AS n FROM answer_outcomes WHERE ${where} GROUP BY final_action, reason ORDER BY n DESC`,
    )
    .all(programId, since, until) as Array<{ final_action: string; reason: string | null; n: number }>;
  const byAction: Record<string, number> = {};
  let total = 0;
  for (const g of groups) {
    byAction[g.final_action] = (byAction[g.final_action] || 0) + g.n;
    total += g.n;
  }
  const rows = (
    handle
      .query(`SELECT * FROM answer_outcomes WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(programId, since, until, limit, offset) as OutcomeRow[]
  ).map((r) => ({
    id: r.id,
    channel: r.channel,
    threadTs: r.thread_ts,
    messageTs: r.message_ts,
    ticketId: r.ticket_id,
    channelRole: r.channel_role,
    addressed: Boolean(r.addressed),
    finalAction: r.final_action,
    reason: r.reason,
    grounded: r.grounded === null ? null : Boolean(r.grounded),
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  }));
  return {
    programId,
    since,
    until,
    total,
    limit,
    offset,
    byAction,
    byReason: groups.map((g) => ({ finalAction: g.final_action, reason: g.reason, count: g.n })),
    rows,
  };
}

export = { record, listForProgram };
