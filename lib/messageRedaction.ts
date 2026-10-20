// When a participant deletes or edits their message in Slack, the copy Orry
// stored must not outlive it. This handles the root message of a ticket (the
// question) and replies inside a ticket thread whose text was stored on an
// event. It never posts to Slack and never throws into the event handler.
import db = require("./db");
import log = require("./log");

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
}

interface ChangeEvent {
  subtype?: string;
  channel?: string;
  deleted_ts?: string;
  message?: SlackMessage;
  previous_message?: SlackMessage;
}

interface TicketRef {
  id: number;
  program_id: string;
  resolution: string | null;
}

// Detail keys that can hold message text or a paraphrase of it.
const TEXT_KEYS = ["text", "reason"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findTicket(channel: string, threadTs: string, workspaceId: string | null): TicketRef | null {
  return (
    (db
      .handle()
      .query(
        `SELECT id, program_id, resolution FROM tickets
         WHERE channel = ? AND thread_ts = ? AND (workspace_id IS NULL OR ? IS NULL OR workspace_id = ?) LIMIT 1`,
      )
      .get(channel, threadTs, workspaceId, workspaceId) as TicketRef | null) || null
  );
}

function stripText(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let detail: Record<string, unknown>;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    detail = parsed as Record<string, unknown>;
  } catch (_) {
    // Unparseable detail cannot be checked, so it cannot be kept.
    return JSON.stringify({ redacted: true });
  }
  if (!TEXT_KEYS.some((key) => key in detail)) return null;
  const clean: Record<string, unknown> = { ...detail };
  for (const key of TEXT_KEYS) delete clean[key];
  clean.redacted = true;
  return JSON.stringify(clean);
}

// Removes text from the ticket's events and their audit copies. With a
// messageTs only the event(s) recorded for that one message are touched.
function redactEventTexts(ticket: TicketRef, messageTs: string | null = null): number {
  const handle = db.handle();
  let changed = 0;
  const events = handle
    .query("SELECT id, detail FROM ticket_events WHERE ticket_id = ? AND detail IS NOT NULL")
    .all(ticket.id) as Array<{ id: number; detail: string }>;
  for (const event of events) {
    if (messageTs) {
      try {
        if (JSON.parse(event.detail)?.ts !== messageTs) continue;
      } catch (_) {
        continue;
      }
    }
    const clean = stripText(event.detail);
    if (clean === null) continue;
    handle.query("UPDATE ticket_events SET detail = ? WHERE id = ?").run(clean, event.id);
    changed += 1;
  }
  const audits = handle
    .query(
      "SELECT id, metadata FROM audit_events WHERE entity_type = 'ticket' AND entity_id = ? AND metadata IS NOT NULL",
    )
    .all(String(ticket.id)) as Array<{ id: number; metadata: string }>;
  for (const audit of audits) {
    if (messageTs) {
      try {
        if (JSON.parse(audit.metadata)?.ts !== messageTs) continue;
      } catch (_) {
        continue;
      }
    }
    const clean = stripText(audit.metadata);
    if (clean === null) continue;
    handle.query("UPDATE audit_events SET metadata = ? WHERE id = ?").run(clean, audit.id);
  }
  return changed;
}

// Orry's own messages about the ticket (the card quotes the question).
function purgeOutbound(ticketId: number): void {
  try {
    require("./outboundLog").purgeTicketText(ticketId);
  } catch (_) {}
}

function tombstone(ticket: TicketRef, kind: "deleted" | "edited", at: number): void {
  db.addTicketEvent({
    ticketId: ticket.id,
    programId: ticket.program_id,
    actorId: null,
    eventType: kind === "deleted" ? "root_message_deleted" : "root_message_edited",
    detail: null,
    createdAt: at,
  });
}

// The question was deleted: drop it and everything stored from the thread.
// The row stays as a tombstone (ids, times, status) so counts still add up.
function redactDeletedRoot(ticket: TicketRef, at = Date.now()): void {
  const resolution =
    typeof ticket.resolution === "string" && ticket.resolution.startsWith("auto-resolved:")
      ? "auto-resolved:"
      : ticket.resolution;
  db.handle()
    .query(
      `UPDATE tickets SET question = '', summary = NULL, resolution_summary = NULL, resolution = ?,
         text_redacted_at = ?, text_redaction = 'deleted' WHERE id = ?`,
    )
    .run(resolution, at, ticket.id);
  redactEventTexts(ticket);
  purgeOutbound(ticket.id);
  tombstone(ticket, "deleted", at);
}

// The question was edited: drop the stored copy and its summary rather than
// keep words the participant took back. The new text is not stored.
function redactEditedRoot(ticket: TicketRef, at = Date.now()): void {
  db.handle()
    .query(
      `UPDATE tickets SET question = '', summary = NULL, text_redacted_at = ?,
         text_redaction = COALESCE(text_redaction, 'edited') WHERE id = ?`,
    )
    .run(at, ticket.id);
  purgeOutbound(ticket.id);
  tombstone(ticket, "edited", at);
}

// Returns what it did, for logs and tests: "root_deleted", "root_edited",
// "reply_deleted", "reply_edited" or null when the message is not stored.
function handleMessageChange(event: ChangeEvent, workspaceId: string | null = null): string | null {
  try {
    const channel = event.channel;
    if (!channel) return null;
    // Orry edits and deletes its own messages all the time (streaming answers,
    // placeholders). Bot messages are never a participant's text.
    if (event.previous_message?.bot_id || (event.message?.bot_id && event.message?.subtype !== "tombstone")) {
      return null;
    }
    if (event.subtype === "message_deleted") {
      const ts = event.deleted_ts || event.previous_message?.ts;
      if (!ts) return null;
      const root = findTicket(channel, ts, workspaceId);
      if (root) {
        redactDeletedRoot(root);
        log.info("redaction", `ticket #${root.id}: root message deleted in Slack, stored text removed`);
        return "root_deleted";
      }
      const threadTs = event.previous_message?.thread_ts;
      const parent = threadTs ? findTicket(channel, threadTs, workspaceId) : null;
      if (parent && redactEventTexts(parent, ts) > 0) return "reply_deleted";
      return null;
    }
    if (event.subtype === "message_changed") {
      const next = event.message || {};
      const ts = next.ts || event.previous_message?.ts;
      if (!ts) return null;
      const root = findTicket(channel, ts, workspaceId);
      // A root deleted while it has replies arrives as a change to a tombstone.
      if (root && next.subtype === "tombstone") {
        redactDeletedRoot(root);
        log.info("redaction", `ticket #${root.id}: root message deleted in Slack, stored text removed`);
        return "root_deleted";
      }
      // Slack also sends message_changed for reply counts, unfurls and the
      // like; only a change of the words counts as an edit.
      const before = event.previous_message?.text;
      if (typeof before !== "string" || typeof next.text !== "string" || before === next.text) return null;
      if (root) {
        redactEditedRoot(root);
        log.info("redaction", `ticket #${root.id}: root message edited in Slack, stored text removed`);
        return "root_edited";
      }
      const threadTs = next.thread_ts || event.previous_message?.thread_ts;
      const parent = threadTs && threadTs !== ts ? findTicket(channel, threadTs, workspaceId) : null;
      if (parent && redactEventTexts(parent, ts) > 0) return "reply_edited";
      return null;
    }
    return null;
  } catch (e: unknown) {
    log.warn("redaction", `message change handling failed: ${errorMessage(e)}`);
    return null;
  }
}

export = { handleMessageChange, redactDeletedRoot, redactEditedRoot, redactEventTexts };
