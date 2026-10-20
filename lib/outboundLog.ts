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

function recordPost(entry: PostEntry): number | null {
  try {
    const t = Date.now();
    const text = typeof entry.text === "string" ? entry.text : null;
    const keep = keepsText(entry.channel, entry.private);
    const res = db
      .handle()
      .query(
        `INSERT INTO outbound_messages (program_id, channel, thread_ts, message_ts, surface, source, status, error, private,
           text, blocks_json, text_chars, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        programFor(entry.programId, entry.channel),
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

export = { recordPost, recordUpdate, recordDelete, errorCode, isDm, MAX_TEXT_CHARS };
