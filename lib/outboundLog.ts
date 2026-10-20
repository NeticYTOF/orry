// A log of what Orry put in Slack: one row per message, updated in place
// when Orry edits or deletes it. Every function here swallows its own
// errors: logging must never break, delay or change a send.
//
// Text is kept only for channel and thread messages. DMs (channel ids that
// start with D, or a user id passed as the channel) and rows marked private
// keep metadata only. A delete removes the text at once.
import db = require("./db");
import log = require("./log");

const MAX_TEXT_CHARS = 8000;
const MAX_BLOCKS_CHARS = 16000;

type Surface = "channel" | "thread" | "dm";

interface PostEntry {
  programId?: string | null;
  channel: string;
  threadTs?: string | null;
  ts?: string | null;
  text?: string | null;
  blocks?: unknown;
  source?: string;
  private?: boolean;
  status?: "sent" | "failed";
  error?: string | null;
  ticketId?: number | null;
}

interface UpdateEntry {
  programId?: string | null;
  channel: string;
  ts: string;
  text?: string | null;
  blocks?: unknown;
  source?: string;
}

interface DeleteEntry {
  programId?: string | null;
  channel: string;
  ts: string;
  source?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDm(channel: string): boolean {
  return /^[DUW]/.test(channel);
}

function surfaceOf(channel: string, threadTs: string | null | undefined, ts: string | null | undefined): Surface {
  if (isDm(channel)) return "dm";
  return threadTs && threadTs !== ts ? "thread" : "channel";
}

function programFor(programId: string | null | undefined, channel: string): string | null {
  if (programId) return programId;
  try {
    const prog = require("./programs").forChannel(channel);
    const shared = require("./programs").shared();
    return prog && prog.id && (!shared || prog.id !== shared.id) ? prog.id : null;
  } catch (_) {
    return null;
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function blocksJson(blocks: unknown): string | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  try {
    return clip(JSON.stringify(blocks), MAX_BLOCKS_CHARS);
  } catch (_) {
    return null;
  }
}

function keepsText(channel: string, isPrivate: boolean | undefined): boolean {
  return !isPrivate && !isDm(channel);
}

function errorCode(error: unknown): string {
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; data?: { error?: unknown } };
  return String(e.data?.error || e.code || errorMessage(error) || "unknown").slice(0, 60);
}

// A message belongs to a ticket when it is in the ticket's thread, or is the
// ticket's card or thread card. Callers that know the ticket pass it.
function ticketFor(channel: string, threadTs: string | null | undefined, ts: string | null | undefined): number | null {
  try {
    const handle = db.handle();
    if (threadTs) {
      const row = handle
        .query("SELECT id FROM tickets WHERE channel = ? AND thread_ts = ? LIMIT 1")
        .get(channel, threadTs) as { id: number } | null;
      if (row) return row.id;
    }
    if (ts) {
      const row = handle.query("SELECT id FROM tickets WHERE card_ts = ? OR public_ack_ts = ? LIMIT 1").get(ts, ts) as {
        id: number;
      } | null;
      if (row) return row.id;
    }
  } catch (_) {}
  return null;
}

// When a participant deletes or edits the question, Orry's own messages
// about that ticket (the card quotes the question) lose their text too.
function purgeTicketText(ticketId: number): number {
  try {
    return db
      .handle()
      .query(
        `UPDATE outbound_messages SET text = NULL, blocks_json = NULL, text_purged_at = COALESCE(text_purged_at, ?)
           WHERE ticket_id = ? AND (text IS NOT NULL OR blocks_json IS NOT NULL)`,
      )
      .run(Date.now(), ticketId).changes;
  } catch (e: unknown) {
    log.debug("outboundLog", `ticket text purge failed: ${errorMessage(e)}`);
    return 0;
  }
}

function recordPost(entry: PostEntry): number | null {
  try {
    const t = Date.now();
    const text = typeof entry.text === "string" ? entry.text : null;
    const keep = keepsText(entry.channel, entry.private);
    const res = db
      .handle()
      .query(
        `INSERT INTO outbound_messages (program_id, ticket_id, channel, thread_ts, message_ts, surface, source, status, error, private,
           text, blocks_json, text_chars, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        programFor(entry.programId, entry.channel),
        entry.ticketId ? Number(entry.ticketId) : ticketFor(entry.channel, entry.threadTs, entry.ts),
        entry.channel,
        entry.threadTs || null,
        entry.ts || null,
        surfaceOf(entry.channel, entry.threadTs, entry.ts),
        entry.source || "program_message",
        entry.status || "sent",
        entry.error ? String(entry.error).slice(0, 60) : null,
        keep ? 0 : 1,
        keep ? clip(text, MAX_TEXT_CHARS) : null,
        keep ? blocksJson(entry.blocks) : null,
        text ? text.length : null,
        t,
        t,
      );
    return Number(res.lastInsertRowid) || null;
  } catch (e: unknown) {
    log.debug("outboundLog", `post not logged: ${errorMessage(e)}`);
    return null;
  }
}

// Orry edited one of its messages (a placeholder turned into the answer, a
// ticket card that changed). The row keeps the latest text only.
function recordUpdate(entry: UpdateEntry): void {
  try {
    const t = Date.now();
    const text = typeof entry.text === "string" ? entry.text : null;
    const row = db
      .handle()
      .query("SELECT id, private, deleted_at FROM outbound_messages WHERE channel = ? AND message_ts = ? LIMIT 1")
      .get(entry.channel, entry.ts) as { id: number; private: number; deleted_at: number | null } | null;
    if (row) {
      if (row.deleted_at) return;
      const keep = !row.private && keepsText(entry.channel, false);
      db.handle()
        .query(
          `UPDATE outbound_messages SET text = ?, blocks_json = COALESCE(?, blocks_json), text_chars = ?, source = COALESCE(?, source),
             edit_count = edit_count + 1, updated_at = ? WHERE id = ?`,
        )
        .run(
          keep ? clip(text, MAX_TEXT_CHARS) : null,
          keep ? blocksJson(entry.blocks) : null,
          text ? text.length : null,
          entry.source || null,
          t,
          row.id,
        );
      return;
    }
    recordPost({
      programId: entry.programId,
      channel: entry.channel,
      ts: entry.ts,
      text,
      blocks: entry.blocks,
      source: entry.source || "update",
    });
  } catch (e: unknown) {
    log.debug("outboundLog", `update not logged: ${errorMessage(e)}`);
  }
}

// Orry deleted one of its messages. The text goes at once; the row stays as
// a tombstone so the log shows that something was posted and removed.
function recordDelete(entry: DeleteEntry): void {
  try {
    const t = Date.now();
    const changed = db
      .handle()
      .query(
        `UPDATE outbound_messages SET text = NULL, blocks_json = NULL, deleted_at = COALESCE(deleted_at, ?), delete_reason = COALESCE(delete_reason, ?),
           updated_at = ? WHERE channel = ? AND message_ts = ?`,
      )
      .run(t, entry.source || "delete", t, entry.channel, entry.ts).changes;
    if (changed > 0) return;
    db.handle()
      .query(
        `INSERT INTO outbound_messages (program_id, channel, message_ts, surface, source, status, private, deleted_at, delete_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'sent', 0, ?, ?, ?, ?)`,
      )
      .run(
        programFor(entry.programId, entry.channel),
        entry.channel,
        entry.ts,
        surfaceOf(entry.channel, null, entry.ts),
        entry.source || "delete",
        t,
        entry.source || "delete",
        t,
        t,
      );
  } catch (e: unknown) {
    log.debug("outboundLog", `delete not logged: ${errorMessage(e)}`);
  }
}

interface RawPayload {
  channel?: unknown;
  thread_ts?: unknown;
  ts?: unknown;
  text?: unknown;
  blocks?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

// For the few places that call chat.postMessage directly: log the payload
// that was sent and the ts Slack returned.
function recordSent(payload: RawPayload, res: unknown, source: string, programId: string | null = null): void {
  try {
    const channel = str(payload.channel);
    if (!channel) return;
    recordPost({
      programId,
      channel,
      threadTs: str(payload.thread_ts),
      ts: str((res as { ts?: unknown } | null)?.ts),
      text: str(payload.text),
      blocks: payload.blocks,
      source,
    });
  } catch (_) {}
}

// For direct chat.update calls: log the new text and blocks on the row.
function recordEdited(payload: RawPayload, source: string, programId: string | null = null): void {
  try {
    const channel = str(payload.channel);
    const ts = str(payload.ts);
    if (!channel || !ts) return;
    recordUpdate({ programId, channel, ts, text: str(payload.text), blocks: payload.blocks, source });
  } catch (_) {}
}

interface OutboundRow {
  id: number;
  ticket_id: number | null;
  channel: string;
  thread_ts: string | null;
  message_ts: string | null;
  surface: string;
  source: string;
  status: string;
  error: string | null;
  private: number;
  text: string | null;
  blocks_json: string | null;
  text_chars: number | null;
  edit_count: number;
  text_purged_at: number | null;
  deleted_at: number | null;
  delete_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface ListParams {
  since?: string | number | null;
  until?: string | number | null;
  limit?: string | number | null;
  offset?: string | number | null;
  source?: string | null;
  channel?: string | null;
  includeBlocks?: string | boolean | null;
  ticketId?: string | number | null;
}

const LIST_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

// Program-scoped read of the log, newest first. Text (and blocks, when
// asked for) is returned only for channel and thread messages that are not
// private; DM rows and private rows are metadata only even if a future
// write path ever stored text for them.
function listForProgram(programId: string, params: ListParams = {}) {
  if (!programId || !require("./programs").get(programId)) return { error: "unknown program" };
  const until = present(params.until) ? Number(params.until) : Date.now();
  const since = present(params.since) ? Number(params.since) : until - LIST_DEFAULT_WINDOW_MS;
  if (!Number.isFinite(since) || !Number.isFinite(until))
    return { error: "since and until must be epoch milliseconds" };
  if (since >= until) return { error: "since must be before until" };
  const limit = Math.min(Math.max(Math.trunc(Number(params.limit)) || 100, 1), 500);
  const offset = Math.max(Math.trunc(Number(params.offset)) || 0, 0);
  const clauses = ["program_id = ?", "created_at > ?", "created_at <= ?"];
  const values: Array<string | number> = [programId, since, until];
  if (present(params.source)) {
    clauses.push("source = ?");
    values.push(String(params.source).slice(0, 40));
  }
  if (present(params.ticketId)) {
    const ticketId = Math.trunc(Number(params.ticketId));
    if (!Number.isFinite(ticketId) || ticketId <= 0) return { error: "ticketId must be a ticket number" };
    clauses.push("ticket_id = ?");
    values.push(ticketId);
  }
  if (present(params.channel)) {
    clauses.push("channel = ?");
    values.push(String(params.channel).slice(0, 40));
  }
  const where = clauses.join(" AND ");
  const total = Number(
    (
      db
        .handle()
        .query(`SELECT COUNT(*) AS n FROM outbound_messages WHERE ${where}`)
        .get(...values) as { n: number }
    )?.n || 0,
  );
  const found = db
    .handle()
    .query(`SELECT * FROM outbound_messages WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...values, limit, offset) as OutboundRow[];
  const withBlocks = params.includeBlocks === true || params.includeBlocks === "1" || params.includeBlocks === "true";
  const rows = found.map((row) => {
    const textAllowed = !row.private && row.surface !== "dm" && !isDm(row.channel) && !row.deleted_at;
    let blocks: unknown = undefined;
    if (withBlocks) {
      try {
        blocks = textAllowed && row.blocks_json ? JSON.parse(row.blocks_json) : null;
      } catch (_) {
        blocks = null;
      }
    }
    return {
      id: row.id,
      ticketId: row.ticket_id,
      channel: row.channel,
      threadTs: row.thread_ts,
      messageTs: row.message_ts,
      surface: row.surface,
      source: row.source,
      status: row.status,
      error: row.error,
      private: Boolean(row.private),
      text: textAllowed ? row.text : null,
      ...(withBlocks ? { blocks } : {}),
      textChars: row.text_chars,
      editCount: row.edit_count,
      textPurgedAt: row.text_purged_at,
      deletedAt: row.deleted_at,
      deleteReason: row.delete_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
  return { programId, since, until, total, limit, offset, rows };
}

export = {
  recordPost,
  recordUpdate,
  recordDelete,
  recordSent,
  recordEdited,
  listForProgram,
  purgeTicketText,
  errorCode,
  isDm,
  MAX_TEXT_CHARS,
};
