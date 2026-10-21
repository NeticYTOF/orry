/* The one contract between the data layer (DATA agent) and everything else. DATA may ADD fields and methods; nobody may remove or rename these. */

export type Person = { id: string; handle: string; name: string };

export type Health = {
  ok: boolean;
  mode: "fixtures" | "bridge";
  checkedAt: string;            // ISO
  lastPollAt: string | null;    // ISO of the last good read from Orry
  openTickets: number | null;
  message: string;              // one plain sentence
  usersReadGranted: boolean;    // can names be read from Slack
  ticketCardsOn: boolean;       // does Orry post ticket cards in Slack
  waitLimitMinutes: number | null; // Orry's own limit, null if it has none
};

export interface DataSource {
  readonly mode: "fixtures" | "bridge";
  health(): Promise<Health>;
  /** Orry's view of a person. null = cannot be checked right now (callers must fail closed). */
  access(slackId: string): Promise<{ admin: boolean; helper: boolean } | null>;
  getSlackUser(slackId: string): Promise<Person | null>;
  findSlackUserByHandle(handle: string): Promise<Person | null>;
  /** Active, non-bot workspace members whose handle or name starts with the query (for the invite form). */
  searchSlackUsers(query: string, limit?: number): Promise<Person[]>;
  /** People on Orry's helper list or admin list, with their role. */
  roster(): Promise<Array<Person & { role: "helper" | "organizer" }>>;

  /* ---------- added by DATA: ticket reads (all program "loadout", all read-only) ---------- */

  /** One page of `GET …/programs/loadout/tickets/search`. Same semantics as Core: one ORDER BY column, no id tie-break. */
  searchTickets(q: TicketSearch): Promise<TicketPage>;
  /**
   * `GET …/programs/loadout/tickets/:id`. null = not found (or another program). Core at 696d203 returns the OLDEST 100
   * events; with G10 (orry-bot-patched 124add3) it returns the NEWEST page. `eventsWindow` says which.
   */
  ticketDetail(id: number): Promise<TicketDetail | null>;
  /** `GET …/programs/loadout/wait` (K12). */
  waitEstimate(): Promise<WaitEstimate>;
  /** The loadout entry of `GET /internal/v1/programs`, already filtered. */
  program(): Promise<ProgramConfig>;
  /** Names for Slack IDs (`POST /internal/v1/slack/users/info`). Missing or failed IDs map to null. */
  usersInfo(ids: string[]): Promise<Record<string, SlackUserInfo | null>>;
  /**
   * G9 (closing events per finished ticket). Optional: returns null when the route is not deployed,
   * and the metrics fall back to the phase 1 row rule.
   */
  closings(sinceMs: number, untilMs: number): Promise<ClosingInfo[] | null>;
  /** The instant the data describes. Fixtures: ORRY_NOW (a fixed instant). Bridge: the real clock. */
  now(): number;
  /**
   * Which of these Slack IDs are organizers (Core's admin list). Only the bridge needs it: Core's helpers route lists
   * helpers only and there is no route that lists admins, so the site asks the access route about the people who
   * appear in the data (owners, first responders, credited helpers, helper closes). Sources whose roster() already
   * has the organizers leave it out.
   */
  organizersAmong?(ids: string[]): Promise<string[]>;
}

/* ---------- ticket shapes, derived from the bot's `Ticket` (lib/types.ts:76-113, commit 696d203) ---------- */

export type TicketStatus =
  | "open" | "waiting_for_helper" | "assigned" | "claimed" | "escalated" | "reopened"
  | "resolved" | "closed" | "snoozed" | "duplicate" | "waiting_for_user";
export type TicketVisibility = "thread" | "organizer" | "dashboard";

/** `OPEN_GROUP` in lib/web/dashboardApi.ts:90. */
export const OPEN_STATUSES: readonly TicketStatus[] = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];
/** Needs a human by status alone (PLAN 4.1; status `open` joins only when `assigned_at` is set, a released ticket). */
export const NEEDS_HUMAN_STATUSES: readonly TicketStatus[] = ["waiting_for_helper", "escalated", "reopened", "claimed", "assigned"];

/** A row of `tickets/search` (`SELECT *` plus `first_responder_id`, `notes_count`). Times are ms since epoch. */
export type TicketRow = {
  id: number;
  program_id: string;
  channel: string;
  thread_ts: string;
  card_ts: string | null;
  requester_id: string;
  question: string;
  status: TicketStatus;
  assignee_id: string | null;
  resolution: string | null;
  created_at: number;
  claimed_at: number | null;
  resolved_at: number | null;
  category: string | null;
  summary: string | null;
  first_response_at: number | null;
  first_human_response_at: number | null;
  visibility: TicketVisibility | null;
  assigned_at: number | null;
  reopened_at: number | null;
  reopen_count: number;
  snoozed_until: number | null;
  updated_at: number | null;
  public_ack_ts: string | null;
  resolved_by: string | null;
  resolved_credit_id: string | null;
  reopened_by: string | null;
  duplicate_of: number | null;
  first_responder_id: string | null;
  notes_count: number;
  /** G29 (orry-bot-patched 5bb53ba): moves forward on every human reply. Absent on older bots. */
  last_human_reply_at?: number | null;
  /** G31 (orry-bot-patched e2eebdd): set when the participant deleted or edited the root message; the text is gone. */
  text_redacted_at?: number | null;
  text_redaction?: "deleted" | "edited" | null;
};

/**
 * A ticket with every text field removed (question, summary, resolution text). This is what the stats
 * caches hold for 10 minutes. The finished-by label and the sensitive flag are computed before the text is dropped.
 */
export type TicketMeta = Omit<TicketRow, "question" | "summary" | "resolution"> & {
  /** The phase 1 row rule's label (PLAN 5.3), from the `resolution` prefix; null while not finished. */
  rowLabel: FinishedByLabel | null;
  /** The site's approximate detector matched the question (never the bot's own detection). */
  sensitive: boolean;
  /** Not one of the program's channels (PLAN 2.4 rule 16): organizers only, no text, no Slack link. */
  outsideChannels: boolean;
  /** A finished row whose resolution text matches none of the known prefixes (the drift canary, PLAN 5.3 caveat 5). */
  unclassified: boolean;
};

export type TicketSearch = {
  status?: TicketStatus;
  statusGroup?: "open" | "resolved";
  /** created_at > since */
  since?: number;
  /** created_at <= until */
  until?: number;
  sort?: "created" | "updated" | "waiting";
  limit?: number;
  offset?: number;
};
export type TicketPage = { total: number; rows: TicketRow[] };

/** Event types the bot writes (lib/tickets.ts recordTransition, resolutionWatcher, ticketBackfill, macros). */
export type TicketEventType =
  | "created" | "requester_followup" | "escalated" | "assigned" | "claimed" | "unclaimed" | "assignment_declined"
  | "helper_reply" | "rivet_answer" | "reopened" | "resolved" | "closed" | "snoozed" | "duplicate" | "note_added"
  | "resolution_judged" | "macro_sent" | "helper_routing_recommended" | (string & {});

/**
 * An event after the bridge client stripped it (PLAN 2.4 rule 18): `detail` keeps only whitelisted, text-free keys.
 */
export type TicketEvent = {
  id: number;
  ticket_id: number;
  actor_id: string | null;
  event_type: TicketEventType;
  detail: EventDetail | null;
  created_at: number;
};
export type EventDetail = {
  by?: string;            // "ai_no_answer" | "requester" | "helper"
  to?: string;            // assignee Slack ID
  automatic?: boolean;
  source?: string;        // "auto" | "backfill" | other short labels
  rule?: string;          // "last_word"
  verdict?: string;       // judge verdict word
  confidence?: number;
  via?: string;           // "thread" | "dashboard"
  of?: number;            // duplicate of
  until?: number;         // snooze until
  suggested?: string[];   // routing suggestion Slack IDs
  macro?: string;         // macro trigger word (no text)
};

export type TicketNote = { id: number; author_id: string; body: string; created_at: number };

export type TicketDetail = {
  ticket: TicketRow;
  events: TicketEvent[];
  notes: TicketNote[];
  /** true when not every event came back: the newest may be missing ("oldest" window) or the oldest ("newest" window). */
  eventsTruncated: boolean;
  /** "oldest": the first events (Core before G10, the fixtures). "newest": the latest events, oldest-first (G10). */
  eventsWindow?: "oldest" | "newest";
  /** All events of the ticket, when Core says (G10). */
  eventsTotal?: number | null;
};

export type WaitEstimate =
  | { available: true; medianWaitMs: number; sampleSize: number; windowDays: number }
  | { available: false; reason: string; sampleSize: number };

/** Orry's `sla` object (lib/db.ts:1143-1149). All null = no thresholds. */
export type SlaConfig = { unassignedMs: number | null; assignedMs: number | null; waitingMs: number | null };

/** The fields of Loadout's program entry the site uses. Everything else from the global route is dropped. */
export type ProgramConfig = {
  id: "loadout";
  name: string;
  status: string | null;
  posture: string | null;
  ticketVisibility: TicketVisibility | null;
  publicTicketsEnabled: boolean | null;
  /** Channel IDs the program answers in (help channels). */
  channels: string[];
  organizerChannel: string | null;
  autoAssign: boolean | null;
  /** Orry's own SLA thresholds; null when the key is missing ("Not set", not an error). */
  sla: SlaConfig | null;
  retentionDays: number | null;
};

export type SlackUserInfo = {
  slackId: string;
  displayName: string | null;
  realName: string | null;
  username: string | null;
  avatarUrl: string | null;
};

/** One row of the G9 closing route: the latest resolved/closed event of a finished ticket, without text. */
export type ClosingInfo = {
  ticketId: number;
  eventType: "resolved" | "closed" | null; // null: no closing event (macro close)
  /** Core's G9 route: orry (actor NULL), requester, helper (roster or admin), other. */
  actorKind: "orry" | "requester" | "helper" | "other" | null;
  /** Only for helpers (Core never returns the requester's ID here). */
  actorId: string | null;
  source: string | null;
  rule: string | null;
  verdict: string | null;
  confidence: number | null;
  /** Macro trigger when a macro did it (site fixtures only; Core may not supply it). */
  macro: string | null;
};

/* ---------- finished-by (PLAN 5.3, 4.17) ---------- */

export type FinishedByLabel =
  | "orry_last_word" | "orry_judge" | "import_resolved" | "import_closed"
  | "participant" | "helper" | "person_or_macro";

/* ---------- errors (PLAN 4.0 shared panel states) ---------- */

export type DataErrorKind =
  | "not_connected"   // 404 "internal api disabled", or no base URL
  | "unauthorized"    // 401, token mismatch
  | "offline"         // network failure, circuit open
  | "timeout"
  | "shape"           // zod mismatch: the panel's Error state, never a wrong number
  | "needs_update"    // the route is not deployed (a G-gap)
  | "rate_limited"    // the site's own cap
  | "error";          // anything else Core said

export class DataError extends Error {
  constructor(readonly kind: DataErrorKind, message: string, readonly route?: string, readonly gap?: string) {
    super(message);
    this.name = "DataError";
  }
}
export const isDataError = (e: unknown): e is DataError => e instanceof DataError;
