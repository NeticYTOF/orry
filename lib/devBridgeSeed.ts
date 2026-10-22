// Invented data for scripts/dev-bridge.ts. Dev only: the bot never imports
// this file. Every name, id and message here is made up. The people and
// their Slack ids mirror the status site's fixtures
// (orry-site/lib/data/fixtures/people.ts) so both sides agree on who is who.
import db = require("./db");
import people = require("./devBridgePeople");

const {
  PROGRAM_ID,
  WORKSPACE_ID,
  CHANNELS,
  PEOPLE,
  ORGANIZER_IDS,
  HELPER_IDS,
  HELPER_WEIGHTS,
  PARTICIPANTS,
  BOT_MEMBER,
} = people;

const CATEGORIES = ["review", "fulfillment_shipping", "account_access", "site_bug", "advice_how_to", "other"];
const QUESTIONS: Array<[string, string]> = [
  ["review", "How long does review take for a Tools track project?"],
  ["review", "My submission was rejected, can I resubmit after fixing the docs?"],
  ["review", "What does the rubric mean by Technical Depth?"],
  ["review", "Is there a way to see reviewer feedback on my last submission?"],
  ["review", "Does a Research Mode project count toward Systems track XP?"],
  ["fulfillment_shipping", "My Requisition at LV.3 says shipped but there is no tracking number."],
  ["fulfillment_shipping", "Can I change the shipping address on an order I placed yesterday?"],
  ["fulfillment_shipping", "When do FIELD tier Custom Orders ship?"],
  ["fulfillment_shipping", "I spent Bolts on a part but the order page is empty."],
  ["account_access", "I can't sign in to the Loadout site, it keeps sending me back to the start."],
  ["account_access", "My Slack account changed, how do I move my Bolts over?"],
  ["account_access", "The email on my account is wrong, who can fix it?"],
  ["site_bug", "The Track XP bar shows 0 after my project was approved."],
  ["site_bug", "The shop page is not loading for me, is it down?"],
  ["site_bug", "Uploading my build photos gives an error every time."],
  ["advice_how_to", "How do I set up the dev board for the Hardware track?"],
  ["advice_how_to", "How do I write a good README for my submission?"],
  ["advice_how_to", "What counts toward the 40% AI cap?"],
  ["advice_how_to", "How can I split one big project into two Compute track entries?"],
  ["other", "Is there a call this week for people working on Systems projects?"],
  ["other", "Who do I talk to about running a Loadout meetup at my school?"],
  ["other", "Can I work on a project with a friend and both get Bolts?"],
  ["account_access", "I would rather talk to a real person about my account, it's a bit personal."],
  ["other", "Can I talk to a human? I don't want the bot to answer this one."],
];
const FOLLOWUPS = [
  "Thanks, I'll try that tonight.",
  "Still not working, I get the same thing.",
  "Here is a screenshot of what I see.",
  "Oh that fixed it!",
  "Do I need to do anything else?",
];
const ANSWERS = [
  "Reviews usually take about a week. You'll get a message in your thread when it's done.",
  "You can resubmit once the reviewer's notes are fixed. Link the new commit in the same thread.",
  "Track XP updates after the review is approved, sometimes with a few hours of delay.",
  "Custom Orders ship in batches. Check the order page for the batch date.",
];
const JUDGE_REASONS = [
  "The participant said the fix worked.",
  "The participant thanked the helper and confirmed the order arrived.",
  "The question was answered and the participant moved on.",
];

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const WEEKS = 12;
// About 150 tickets over 12 ISO weeks, a little uneven like a real queue.
const TICKETS_PER_WEEK = [10, 11, 13, 12, 14, 12, 13, 15, 12, 14, 13, 11];

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoWeekStart(t: number): number {
  const d = new Date(t);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - sinceMonday * DAY;
}

function isoWeekLabel(t: number): string {
  const d = new Date(isoWeekStart(t) + 3 * DAY);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.floor((d.getTime() - yearStart) / WEEK) + 1;
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function slackTs(ms: number, salt: number): string {
  return `${Math.floor(ms / 1000)}.${String(salt % 1000000).padStart(6, "0")}`;
}

// What scripts/dev-bridge.ts puts in RIVET_PROGRAMS_JSON.
function programConfig() {
  return {
    id: PROGRAM_ID,
    name: "Loadout",
    workspaceId: WORKSPACE_ID,
    posture: "active",
    helpChannel: CHANNELS.help,
    organizerChannel: CHANNELS.organizer,
    channels: [CHANNELS.help, CHANNELS.main],
    ticketVisibility: "thread",
    helperPing: true,
    supportName: "Orry",
  };
}

interface SeedEvent {
  type: string;
  actor: string | null;
  detail: Record<string, unknown> | null;
  at: number;
}

interface SeedSummary {
  tickets: number;
  finished: number;
  open: number;
  events: number;
  audits: number;
  outbound: number;
  outcomes: number;
  weeks: string[];
}

// Builds one ticket's row and timeline the way the live code would have
// written them (see lib/tickets.ts, lib/resolutionWatcher.ts and
// lib/ticketBackfill.ts for the shapes).
class TicketStory {
  fields: Record<string, unknown>;
  events: SeedEvent[] = [];
  answers: Array<{ at: number; text: string }> = [];
  outcome: { action: string; reason: string; grounded: number | null; at: number } | null = null;
  cards = false;
  openOffer: { to: string | null; at: number } | null = null;

  constructor(
    public created: number,
    public requester: string,
    public now: number,
    imported = false,
  ) {
    this.fields = {
      status: "open",
      assignee_id: null,
      claimed_at: null,
      assigned_at: null,
      resolution: null,
      resolved_at: null,
      resolved_by: null,
      resolved_credit_id: null,
      first_response_at: null,
      first_human_response_at: null,
      last_human_reply_at: null,
      reopened_at: null,
      reopen_count: 0,
      visibility: imported ? "dashboard" : "thread",
      snoozed_until: null,
    };
    this.add(
      "created",
      requester,
      imported ? { source: "backfill" } : { channel: CHANNELS.help, source: "support_question" },
      created,
    );
  }

  clamp(at: number): number {
    return Math.round(Math.min(at, this.now - MIN));
  }

  add(type: string, actor: string | null, detail: Record<string, unknown> | null, at: number): number {
    const t = this.clamp(at);
    this.events.push({ type, actor, detail, at: t });
    return t;
  }

  orryAnswers(at: number, text: string): number {
    const t = this.clamp(at);
    this.fields.first_response_at ??= t;
    this.answers.push({ at: t, text });
    this.outcome = { action: "reply", reason: "grounded", grounded: 1, at: t };
    return t;
  }

  escalate(at: number, reason = "gap_escalated"): number {
    const t = this.add("escalated", null, { by: "ai_no_answer" }, at);
    this.fields.status = "waiting_for_helper";
    this.cards = true;
    this.outcome = { action: "escalate", reason, grounded: 0, at: t };
    return t;
  }

  ping(at: number, to: string, source = "ping"): number {
    const t = this.add("helper_assignment_offered", null, { to, source }, at);
    this.openOffer = { to, at: t };
    return t;
  }

  timeout(at: number): number {
    const offer = this.openOffer;
    const t = this.add(
      "helper_assignment_timed_out",
      null,
      { to: offer?.to || null, offeredAt: offer?.at || null },
      at,
    );
    this.openOffer = null;
    return t;
  }

  claim(at: number, helper: string): number {
    const t = this.clamp(at);
    if (this.openOffer) {
      this.add("helper_assignment_claimed", helper, { source: this.openOffer.to === helper ? "targeted" : "pool" }, t);
      this.openOffer = null;
    }
    this.add("claimed", helper, null, t);
    Object.assign(this.fields, { status: "claimed", assignee_id: helper, claimed_at: t, assigned_at: t });
    return t;
  }

  assign(at: number, helper: string): number {
    const t = this.add("assigned", null, { to: helper, automatic: true }, at);
    Object.assign(this.fields, { status: "assigned", assignee_id: helper, assigned_at: t });
    return t;
  }

  reply(at: number, helper: string, text: string | null = null): number {
    const t = this.add("helper_reply", helper, text ? { ts: slackTs(at, 7), text } : { via: "thread" }, at);
    this.fields.first_response_at ??= t;
    this.fields.first_human_response_at ??= t;
    this.fields.last_human_reply_at = t;
    return t;
  }

  followup(at: number, text: string): number {
    return this.add("requester_followup", this.requester, { text }, at);
  }

  resolve(
    at: number,
    actor: string | null,
    detail: Record<string, unknown> | null,
    resolution: string,
    credit: string | null,
  ) {
    const t = this.add("resolved", actor, detail, at);
    this.fields.first_response_at ??= t;
    Object.assign(this.fields, {
      status: "resolved",
      resolution,
      resolved_at: t,
      resolved_by: actor || credit,
      resolved_credit_id: credit,
    });
    return t;
  }

  close(at: number, detail: Record<string, unknown> | null, resolution: string | null): number {
    const t = detail ? this.add("closed", null, detail, at) : this.clamp(at);
    Object.assign(this.fields, { status: "closed", resolution, resolved_at: t });
    return t;
  }

  reopen(at: number): number {
    const t = this.add("reopened", this.requester, { by: "requester" }, at);
    Object.assign(this.fields, {
      status: "reopened",
      resolution: null,
      resolved_at: null,
      resolved_by: null,
      reopened_at: t,
      reopened_by: this.requester,
      reopen_count: Number(this.fields.reopen_count || 0) + 1,
    });
    this.ping(t, null as unknown as string, "reopened");
    return t;
  }

  lastAt(): number {
    return Math.max(this.created, ...this.events.map((e) => e.at), ...this.answers.map((a) => a.at));
  }
}

type Scenario =
  | "helper"
  | "last_word"
  | "judge"
  | "self"
  | "imported"
  | "macro"
  | "reopened_then_resolved"
  | "duplicate"
  | "waiting"
  | "claimed"
  | "assigned"
  | "released"
  | "reopened_open"
  | "open_new"
  | "snoozed";

function weighted<T>(rng: Rng, items: Array<[T, number]>): T {
  const total = items.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r < 0) return item;
  }
  return items[items.length - 1][0];
}

function chooseScenario(rng: Rng, ageMs: number, week: number): Scenario {
  if (ageMs < 2 * DAY) {
    return weighted<Scenario>(rng, [
      ["waiting", 4],
      ["claimed", 3],
      ["assigned", 1],
      ["open_new", 2],
      ["released", 1],
      ["reopened_open", 1],
      ["judge", 1],
      ["helper", 2],
      ["self", 1],
    ]);
  }
  if (rng() < 0.04)
    return weighted<Scenario>(rng, [
      ["waiting", 1],
      ["claimed", 1],
      ["snoozed", 1],
    ]);
  return weighted<Scenario>(rng, [
    ["helper", 35],
    ["last_word", 15],
    ["judge", 15],
    ["self", 12],
    ["imported", week <= 4 ? 12 : 0],
    ["macro", 4],
    ["reopened_then_resolved", 6],
    ["duplicate", 3],
  ]);
}

function tell(story: TicketStory, scenario: Scenario, rng: Rng, helper: () => string, question: string): void {
  const between = (a: number, b: number) => a + rng() * (b - a);
  const pick = <T>(list: T[]) => list[Math.floor(rng() * list.length)];
  const c = story.created;
  const humanRequest = /talk to a (real person|human)/i.test(question);
  const answerFirst = !humanRequest && rng() < 0.45;
  let t = c;
  if (scenario === "imported") {
    const h = helper();
    if (rng() < 0.55) {
      t = story.reply(c + between(20 * MIN, 6 * HOUR), h, pick(ANSWERS));
      story.add(
        "requester_followup",
        story.requester,
        { ts: slackTs(t + HOUR, 9), text: "thanks!", backfill: true },
        t + HOUR,
      );
      story.resolve(t + HOUR, null, { source: "backfill" }, "resolved from historical confirmation", h);
    } else {
      story.close(
        c + 8 * DAY,
        { source: "backfill", reason: "no answer (history import)" },
        "no answer (history import)",
      );
    }
    return;
  }
  if (scenario === "judge") {
    t = story.orryAnswers(c + between(20_000, 3 * MIN), pick(ANSWERS));
    if (rng() < 0.5) t = story.followup(t + between(5 * MIN, 2 * HOUR), pick(FOLLOWUPS));
    const reason = pick(JUDGE_REASONS);
    const verdict = { source: "auto", verdict: "resolved", confidence: Number(between(0.8, 0.97).toFixed(2)), reason };
    story.resolve(t + between(HOUR, 20 * HOUR), null, verdict, `auto-resolved: ${reason}`, null);
    return;
  }
  if (scenario === "open_new") {
    if (answerFirst) story.orryAnswers(c + between(20_000, 2 * MIN), pick(ANSWERS));
    return;
  }
  if (answerFirst) t = story.orryAnswers(c + between(20_000, 2 * MIN), pick(ANSWERS));
  t = story.escalate(t + between(MIN, 6 * MIN), humanRequest ? "sensitive" : "gap_escalated");
  if (scenario === "snoozed") {
    story.add("snoozed", ORGANIZER_IDS[0], { until: story.now + 2 * DAY }, t + HOUR);
    Object.assign(story.fields, { status: "snoozed", snoozed_until: story.now + 2 * DAY });
    return;
  }
  const first = helper();
  t = story.ping(t + between(MIN, 10 * MIN), first);
  if (scenario === "waiting") return;
  if (scenario === "assigned") {
    story.assign(t + between(MIN, 5 * MIN), first);
    return;
  }
  let owner = first;
  if (rng() < 0.75) {
    t = story.claim(t + between(5 * MIN, 90 * MIN), first);
  } else {
    t = story.timeout(t + 30 * MIN);
    owner = helper();
    t = story.claim(t + between(5 * MIN, 3 * HOUR), owner);
  }
  if (scenario === "claimed") {
    if (rng() < 0.6) story.reply(t + between(2 * MIN, 30 * MIN), owner);
    return;
  }
  if (scenario === "released") {
    t = story.add("unclaimed", owner, null, t + between(10 * MIN, 2 * HOUR));
    Object.assign(story.fields, { status: "open", assignee_id: null, claimed_at: null });
    story.ping(t, null as unknown as string, "released");
    return;
  }
  if (scenario === "duplicate") {
    story.fields.status = "duplicate";
    return;
  }
  const replies = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < replies; i += 1) {
    t = story.reply(t + between(2 * MIN, 40 * MIN), owner, rng() < 0.15 ? pick(ANSWERS) : null);
    if (rng() < 0.4) t = story.followup(t + between(3 * MIN, 30 * MIN), pick(FOLLOWUPS));
  }
  if (scenario === "reopened_open" || scenario === "reopened_then_resolved") {
    t = story.resolve(t + between(10 * MIN, 6 * HOUR), owner, null, `resolved by <@${owner}>`, owner);
    t = story.reopen(t + between(2 * HOUR, 2 * DAY));
    t = story.followup(t, pick(FOLLOWUPS));
    if (scenario === "reopened_open") return;
    t = story.reply(t + between(20 * MIN, 5 * HOUR), owner);
    story.resolve(t + between(10 * MIN, 3 * HOUR), owner, null, `resolved by <@${owner}>`, owner);
    return;
  }
  if (scenario === "helper") {
    story.resolve(t + between(10 * MIN, 20 * HOUR), owner, null, `resolved by <@${owner}>`, owner);
  } else if (scenario === "last_word") {
    story.resolve(
      t,
      null,
      { source: "auto", rule: "last_word", helper: owner },
      "resolved: a helper had the last word and the requester didn't come back",
      owner,
    );
  } else if (scenario === "self") {
    story.resolve(t + between(5 * MIN, 5 * HOUR), story.requester, null, `resolved by <@${story.requester}>`, owner);
  } else if (scenario === "macro") {
    t = story.add("macro_sent", owner, { macroId: 1, trigger: "?wrapup" }, t + between(5 * MIN, 2 * HOUR));
    story.close(t, null, null);
  }
}

const TICKET_COLUMNS = [
  "status",
  "assignee_id",
  "claimed_at",
  "assigned_at",
  "resolution",
  "resolved_at",
  "resolved_by",
  "resolved_credit_id",
  "first_response_at",
  "first_human_response_at",
  "last_human_reply_at",
  "reopened_at",
  "reopened_by",
  "reopen_count",
  "visibility",
  "snoozed_until",
  "duplicate_of",
  "card_ts",
  "public_ack_ts",
  "updated_at",
];

interface Ctx {
  now: number;
  rng: Rng;
  summary: SeedSummary;
  between: (a: number, b: number) => number;
  out: (entry: Record<string, unknown>, at: number, deleted?: boolean) => void;
  outcome: (o: {
    channel: string;
    threadTs: string;
    ticketId: number | null;
    action: string;
    reason: string;
    grounded: number | null;
    at: number;
    addressed?: number;
  }) => void;
  audit: (actor: string | null, action: string, ticketId: number, metadata: unknown, at: number) => void;
}

function makeContext(now: number, rng: Rng, summary: SeedSummary): Ctx {
  const handle = db.handle();
  const between = (a: number, b: number) => a + rng() * (b - a);
  const outboundLog = require("./outboundLog");
  const insertOutcome = handle.query(
    `INSERT INTO answer_outcomes (program_id, channel, thread_ts, message_ts, ticket_id, channel_role, addressed,
       final_action, reason, grounded, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAudit = handle.query(
    `INSERT INTO audit_events (program_id, actor_id, action, entity_type, entity_id, metadata, created_at)
     VALUES (?, ?, ?, 'ticket', ?, ?, ?)`,
  );
  return {
    now,
    rng,
    summary,
    between,
    out(entry, at, deleted = false) {
      const id = outboundLog.recordPost({ programId: PROGRAM_ID, ...entry });
      if (!id) return;
      if (deleted) outboundLog.recordDelete({ channel: entry.channel, ts: entry.ts, source: "placeholder_discard" });
      handle
        .query(
          `UPDATE outbound_messages SET created_at = ?, updated_at = ?,
             deleted_at = CASE WHEN deleted_at IS NULL THEN NULL ELSE ? END WHERE id = ?`,
        )
        .run(at, at, at, id);
      summary.outbound += 1;
    },
    outcome(o) {
      const latency = o.action === "silence" ? between(200, 1500) : between(1800, 9000);
      insertOutcome.run(
        PROGRAM_ID,
        o.channel,
        o.threadTs,
        o.threadTs,
        o.ticketId,
        o.channel === CHANNELS.help ? "help" : "main",
        o.addressed === undefined ? 1 : o.addressed,
        o.action,
        o.reason,
        o.grounded,
        Math.round(latency),
        o.at,
      );
      summary.outcomes += 1;
    },
    audit(actor, action, ticketId, metadata, at) {
      insertAudit.run(PROGRAM_ID, actor, action, String(ticketId), metadata ? JSON.stringify(metadata) : null, at);
      summary.audits += 1;
    },
  };
}

// `o` pins the scenario or the channel (the site cases below); otherwise both come
// from the random history. Returns the new ticket id.
function seedTicket(
  ctx: Ctx,
  week: number,
  created: number,
  serial: number,
  helper: () => string,
  weekIds: number[],
  o: { scenario?: Scenario; channel?: string } = {},
): number | null {
  const { rng, now, summary } = ctx;
  const handle = db.handle();
  const [category, question] = QUESTIONS[Math.floor(rng() * QUESTIONS.length)];
  const requester = PARTICIPANTS[Math.floor(rng() * PARTICIPANTS.length)].id;
  const chosen = chooseScenario(rng, now - created, week);
  const scenario = o.scenario || chosen;
  const channel = o.channel || CHANNELS.help;
  const threadTs = slackTs(created, serial);
  const story = new TicketStory(created, requester, now, scenario === "imported");
  tell(story, scenario, rng, helper, question);
  const id = db.createTicket({
    programId: PROGRAM_ID,
    workspaceId: WORKSPACE_ID,
    channel,
    threadTs,
    requesterId: requester,
    question,
    category,
    createdAt: created,
    visibility: String(story.fields.visibility),
  });
  if (!id) return null;
  if (scenario === "duplicate" && weekIds.length > 0) story.fields.duplicate_of = weekIds[0];
  weekIds.push(id);
  if (story.cards) {
    story.fields.public_ack_ts = slackTs(created + 2 * MIN, serial + 500000);
    story.fields.card_ts = slackTs(created + 2 * MIN, serial + 600000);
  }
  story.fields.updated_at = story.lastAt();
  const sets = TICKET_COLUMNS.map((c) => `${c} = ?`).join(", ");
  const values = TICKET_COLUMNS.map((c) => (story.fields[c] === undefined ? null : story.fields[c]));
  handle
    .query(`UPDATE tickets SET ${sets}, priority = ? WHERE id = ?`)
    .run(...(values as never[]), rng() < 0.15 ? "high" : "normal", id);
  for (const event of story.events) {
    db.addTicketEvent({
      ticketId: id,
      programId: PROGRAM_ID,
      actorId: event.actor,
      eventType: event.type,
      detail: event.detail,
      createdAt: event.at,
    });
    summary.events += 1;
    // The assignment lifecycle writes metrics, not audit rows.
    if (!event.type.startsWith("helper_assignment_")) {
      ctx.audit(event.actor, `ticket.${event.type}`, id, event.detail, event.at);
    }
  }
  for (const answer of story.answers) {
    const ts = slackTs(answer.at, serial + 100000);
    ctx.out({ channel, threadTs, ts, text: answer.text, source: "answer" }, answer.at);
  }
  if (story.cards) {
    const at = created + 2 * MIN;
    const ack = "Someone will be here to help you soon!";
    const card = `[Ticket #${id}] <@${requester}> asked: "${question.slice(0, 100)}"`;
    const cardTs = story.fields.card_ts;
    ctx.out({ channel, threadTs, ts: story.fields.public_ack_ts, text: ack, source: "ticket_thread_card" }, at);
    ctx.out({ channel: CHANNELS.organizer, ts: cardTs, text: card, source: "ticket_card", ticketId: id }, at);
    if (rng() < 0.15) {
      const ts = slackTs(created + MIN, serial + 700000);
      ctx.out({ channel, threadTs, ts, text: "Thinking...", source: "placeholder" }, created + MIN, true);
    }
    // The SLA loop notified organizers about some tickets nobody had taken yet.
    if (rng() < 0.2 && !story.fields.first_human_response_at) {
      ctx.audit(null, "sla.notified", id, { rule: "unassigned" }, Math.min(created + 2 * HOUR, now - MIN));
    }
  }
  // Only help-channel tickets get an answer-pipeline row here.
  if (story.outcome && channel === CHANNELS.help) {
    const o = story.outcome;
    ctx.outcome({
      channel,
      threadTs,
      ticketId: id,
      action: o.action,
      reason: o.reason,
      grounded: o.grounded,
      at: o.at,
    });
  }
  summary.tickets += 1;
  if (["resolved", "closed"].includes(String(story.fields.status))) summary.finished += 1;
  else summary.open += 1;
  return id;
}

// Messages the pipeline looked at and stayed quiet on, or declined, plus the
// weekly report Orry posts on Mondays.
function seedChannelTraffic(ctx: Ctx, firstWeek: number, startSerial: number) {
  const { rng, now, summary, between } = ctx;
  let serial = startSerial;
  for (let w = 0; w < WEEKS; w += 1) {
    const start = firstWeek + w * WEEK;
    for (let k = 0; k < 28; k += 1) {
      const at = Math.round(start + between(0, Math.max(0, Math.min(WEEK, now - MIN - start))));
      const channel = rng() < 0.7 ? CHANNELS.main : CHANNELS.help;
      serial += 1;
      const [action, reason] = weighted<[string, string]>(rng, [
        [["silence", "ambient_chatter"], 10],
        [["silence", "help_chatter"], 3],
        [["silence", "thread_humans_talking"], 3],
        [["silence", "subjectless"], 1],
        [["uncertain", "ungrounded"], 2],
        [["reply", "grounded"], 3],
      ]);
      const grounded = action === "reply" ? 1 : action === "uncertain" ? 0 : null;
      const addressed = action === "silence" ? 0 : 1;
      ctx.outcome({ channel, threadTs: slackTs(at, serial), ticketId: null, action, reason, grounded, at, addressed });
    }
    const report = start + 9 * HOUR;
    if (w > 0 && report < now) {
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: `*Week ${summary.weeks[w - 1]}* (invented numbers)` } },
      ];
      const ts = slackTs(report, 900000 + w);
      ctx.out({ channel: CHANNELS.organizer, ts, text: "Orry weekly report", blocks, source: "weekly_report" }, report);
    }
  }
  const dmText = "A DM reply; the log keeps no text for DMs.";
  ctx.out(
    { channel: "D0DEVDM001", ts: slackTs(now - 3 * DAY, 1), text: dmText, source: "program_message" },
    now - 3 * DAY,
  );
  const failed = { channel: CHANNELS.organizer, status: "failed", error: "not_in_channel", text: "A failed send." };
  ctx.out({ ...failed, source: "ops_alert" }, now - 5 * DAY);
}

// Four tickets a status site needs to see at least once, on top of the random
// history: one an organizer (on the admin list, not the helper list) took and
// finished, so the site has to know organizers count as staff; one from a
// direct message, outside the program's channels; one whose question the
// participant deleted and one they edited, both through the real redaction
// code (lib/messageRedaction.ts), so the stored text is gone.
function seedSiteCases(ctx: Ctx, firstWeek: number, startSerial: number): void {
  const { now } = ctx;
  const lastFullWeek = firstWeek + (WEEKS - 2) * WEEK;
  const thisWeek = firstWeek + (WEEKS - 1) * WEEK;
  const redaction = require("./messageRedaction");
  const organizer = () => ORGANIZER_IDS[0];
  const anyHelper = () => HELPER_IDS[1];
  const ref = (id: number) =>
    db.handle().query("SELECT id, program_id, resolution FROM tickets WHERE id = ?").get(id) as {
      id: number;
      program_id: string;
      resolution: string | null;
    };
  const when = (start: number, day: number, hour: number) => Math.min(start + day * DAY + hour * HOUR, now - 2 * HOUR);
  let serial = startSerial;
  seedTicket(ctx, WEEKS - 2, when(lastFullWeek, 2, 16), ++serial, organizer, [], { scenario: "helper" });
  seedTicket(ctx, WEEKS - 1, Math.max(thisWeek, now - 5 * HOUR), ++serial, anyHelper, [], {
    scenario: "waiting",
    channel: "D0DEVDM001",
  });
  const deleted = seedTicket(ctx, WEEKS - 1, Math.max(thisWeek, now - 4 * HOUR), ++serial, anyHelper, [], {
    scenario: "claimed",
  });
  if (deleted) redaction.redactDeletedRoot(ref(deleted), now - 3 * HOUR);
  const edited = seedTicket(ctx, WEEKS - 2, when(lastFullWeek, 3, 18), ++serial, anyHelper, [], { scenario: "helper" });
  if (edited) redaction.redactEditedRoot(ref(edited), when(lastFullWeek, 3, 19));
}

// Fills an open database with the invented program's history. Idempotent
// per database: a database that already has tickets for the program is
// left alone. Everything runs in one transaction.
function seed({ now = Date.now(), seed: seedValue = 20261020 }: { now?: number; seed?: number } = {}): SeedSummary {
  const handle = db.handle();
  const existing = Number(
    (handle.query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = ?").get(PROGRAM_ID) as { n: number }).n,
  );
  const summary: SeedSummary = {
    tickets: 0,
    finished: 0,
    open: 0,
    events: 0,
    audits: 0,
    outbound: 0,
    outcomes: 0,
    weeks: [],
  };
  const firstWeek = isoWeekStart(now) - (WEEKS - 1) * WEEK;
  for (let w = 0; w < WEEKS; w += 1) summary.weeks.push(isoWeekLabel(firstWeek + w * WEEK));
  if (existing > 0) return { ...summary, tickets: existing };

  const rng = mulberry32(seedValue);
  const ctx = makeContext(now, rng, summary);
  const helperTotal = HELPER_WEIGHTS.reduce((a, b) => a + b, 0);
  const helper = () => {
    let r = rng() * helperTotal;
    for (let i = 0; i < HELPER_IDS.length; i += 1) {
      r -= HELPER_WEIGHTS[i];
      if (r < 0) return HELPER_IDS[i];
    }
    return HELPER_IDS[0];
  };

  handle.exec("BEGIN");
  try {
    for (const userId of HELPER_IDS) db.syncHelper({ programId: PROGRAM_ID, userId, source: "manual" });
    handle.query("UPDATE program_helpers SET added_at = ? WHERE program_id = ?").run(firstWeek - 14 * DAY, PROGRAM_ID);
    let serial = 0;
    for (let w = 0; w < WEEKS; w += 1) {
      const start = firstWeek + w * WEEK;
      const end = Math.min(start + WEEK, now - 20 * MIN);
      if (end <= start) continue;
      const weekIds: number[] = [];
      for (let k = 0; k < TICKETS_PER_WEEK[w]; k += 1) {
        const hour = rng() < 0.7 ? ctx.between(14, 23) : ctx.between(0, 24);
        let created = start + Math.floor(rng() * 7) * DAY + hour * HOUR;
        if (created >= end) created = ctx.between(start, end);
        serial += 1;
        seedTicket(ctx, w, Math.round(created), serial, helper, weekIds);
      }
    }
    seedChannelTraffic(ctx, firstWeek, serial);
    seedSiteCases(ctx, firstWeek, 900);
    handle.exec("COMMIT");
  } catch (e) {
    handle.exec("ROLLBACK");
    throw e;
  }
  return summary;
}

function slackError(code: string) {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
}

// The fake Slack client the dev bridge hands to Core: users.info and
// channel membership answer from the invented people; anything that would
// post or change Slack throws, so nothing can leave the machine.
function fakeSlackClient() {
  const everyone = [...PEOPLE, ...PARTICIPANTS];
  const byId = new Map<string, { id: string; handle: string; name: string; isBot?: boolean }>(
    [...everyone, BOT_MEMBER].map((p) => [p.id, p]),
  );
  // Organizers, helpers, a few people who are not on the roster yet, and a bot.
  const organizerMembers = [
    ...new Set([...ORGANIZER_IDS, ...HELPER_IDS, "U0QUIN001", "U0OLI0001", "U0CAL0001", BOT_MEMBER.id]),
  ];
  const refuse = async () => {
    throw slackError("dev_bridge_no_slack");
  };
  const channelName = (id: string) => Object.entries(CHANNELS).find(([, value]) => value === id)?.[0] || "unknown";
  return {
    users: {
      info: async ({ user }: { user: string }) => {
        const p = byId.get(user);
        if (!p) throw slackError("user_not_found");
        const profile = { real_name: p.name, display_name: p.handle };
        return { ok: true, user: { id: p.id, name: p.handle, is_bot: Boolean(p.isBot), deleted: false, profile } };
      },
    },
    conversations: {
      members: async ({ channel }: { channel: string }) => ({
        ok: true,
        members: channel === CHANNELS.organizer ? organizerMembers : everyone.map((p) => p.id),
        response_metadata: { next_cursor: "" },
      }),
      info: async ({ channel }: { channel: string }) => ({
        ok: true,
        channel: { id: channel, name: `loadout-${channelName(channel)}`, is_member: true, is_private: false },
      }),
      list: async () => ({
        ok: true,
        channels: Object.values(CHANNELS).map((id) => ({ id, name: `loadout-${channelName(id)}`, is_member: true })),
        response_metadata: { next_cursor: "" },
      }),
      join: refuse,
      history: async () => ({ ok: true, messages: [] }),
      replies: async () => ({ ok: true, messages: [] }),
    },
    chat: { postMessage: refuse, update: refuse, delete: refuse, postEphemeral: refuse },
    reactions: { add: refuse, remove: refuse },
  };
}

export = {
  PROGRAM_ID,
  WORKSPACE_ID,
  CHANNELS,
  PEOPLE,
  ORGANIZER_IDS,
  HELPER_IDS,
  PARTICIPANTS,
  CATEGORIES,
  programConfig,
  seed,
  fakeSlackClient,
  isoWeekStart,
};
