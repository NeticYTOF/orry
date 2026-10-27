import configModule = require("./config");
import visionModule = require("./vision");
import intent = require("./intent");
import contextModule = require("./context");
import respondModule = require("./respond");
import replyText = require("./reply");
import learnModule = require("./learn");
import teachThreadModule = require("./teachThread");
import sumThreadModule = require("./sumThread");
import dbModule = require("./db");
import rateLimitModule = require("./rateLimit");
import log = require("./log");
import programsModule = require("./programs");
import macrosModule = require("./macros");
import channelPolicyModule = require("./channelPolicy");
import workspaceModule = require("./workspace");
import reactionHandlers = require("./reactionHandlers");
import slackEventPolicy = require("./slackEventPolicy");
import brand = require("./brand");
import type { Program, SlackClient, Ticket } from "./types";

const { config, isAdmin } = configModule;
const { worthClassifying } = intent;
interface SlackFile {
  mimetype?: string;
  url_private?: string;
}
interface HandlerEvent {
  ts: string;
  channel: string;
  user: string;
  text: string;
  thread_ts?: string;
  parent_user_id?: string;
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
  team?: string;
  files?: SlackFile[];
}
interface HandlerArgs {
  event: HandlerEvent;
  client: SlackClient;
  body?: { team_id?: string; team?: { id?: string } };
}
interface ImageArgs extends HandlerArgs {
  imageFile: SlackFile;
  program?: Program | null;
}
interface ProgramPolicy {
  role: string;
  program: Program;
  settings?: { enabled?: boolean; commandsEnabled?: boolean };
}
interface MacroRow {
  id?: number;
  trigger?: string;
  enabled?: number;
}
interface TicketTarget {
  ticket: { id: number } | null;
  program: Program | null;
}
interface MacroTrigger {
  trigger: string;
}
interface ThreadCrowd {
  othersPresent: boolean;
  orryIn: boolean;
}
interface HandlerDb {
  claimMessage(ts: string, channel?: string | null): boolean;
  clearTakeover(threadTs: string): void;
  getTicketByThreadTs(
    threadTs?: string,
    workspaceId?: string | null,
  ): (Pick<Ticket, "id" | "channel" | "program_id" | "status"> & { workspace_id?: string | null }) | null;
  isHelper(programId: string, userId: string): boolean;
  isTakeover(threadTs: string): boolean;
  isThreadMuted(threadTs: string): boolean;
  markTakeover(threadTs: string, channel: string, userId: string): void;
  recordFeedback(messageTs: string, userId: string, vote: number | string): void;
  recordGap(
    question: string,
    userId?: string | null,
    channel?: string | null,
    messageTs?: string | null,
    programId?: string | null,
  ): void;
  recordMetric(name: string, latency?: number | null, detail?: string | null, programId?: string | null): void;
  recordUserMessage(input: { userId: string; channel: string; threadTs: string; text: string }): void;
  removeFeedback(messageTs: string, userId: string): void;
  unmuteThread(threadTs: string): void;
  wasAnswered(messageTs: string): boolean;
}
interface HandlerContext {
  addToThread(threadTs: string, role: string, content: string, userId?: string | null, channel?: string | null): void;
  fetchThreadCrowd(
    client: SlackClient,
    input: {
      channel: string;
      threadTs?: string;
      messageTs: string;
      userId: string;
      botUserId: string;
      parentUserId?: string | null;
    },
  ): Promise<ThreadCrowd>;
  getThreadContext(threadTs: string): string;
  hasSpokenInThread(threadTs: string): boolean;
  updateUserHistory(userId: string, question: string, answered: boolean): void;
}
interface HandlerRespond {
  ALWAYS: string;
  ERROR_FALLBACK: string;
  HELP_ONLY: string;
  respond(args: object): Promise<unknown>;
}
interface HandlerPrograms {
  forChannel(channel: string | null | undefined, workspaceId?: string | null, options?: object): Program;
  get(id: string): Program | null;
  shared(): Program;
}
interface HandlerMacros {
  list(programId: string, options?: { enabledOnly?: boolean }): MacroRow[];
  normalizeTrigger(value: string): string;
  send(args: object): Promise<{ ok?: boolean; error?: string }>;
  sendToThread(args: object): Promise<{ ok?: boolean; error?: string }>;
}
interface HandlerPolicy {
  resolve(channel: string, workspaceId?: string | null, options?: { isDm?: boolean }): ProgramPolicy;
}
interface HandlerWorkspace {
  workspaceOf(event: HandlerEvent, body?: { team_id?: string; team?: { id?: string } }): string | null;
  explicitWorkspaceOf(event: HandlerEvent, body?: { team_id?: string; team?: { id?: string } }): string | null;
}
interface HandlerVision {
  analyzeImage(
    url?: string,
    question?: string,
    context?: string,
    token?: string,
    docs?: string,
    requireGrounded?: boolean,
  ): Promise<string | null>;
  isGroundedImageReply(reply: string, question: string, docs: string): boolean;
  groundedImageReply(reply: string, question: string, docs: string): string | null;
}
interface HandlerLearn {
  parseTeach(text: string): { question: string; answer: string } | null;
  teach(input: {
    question: string;
    answer: string;
    authorId: string;
    threadTs?: string | null;
    channel?: string | null;
    programId?: string | null;
  }): number | null;
}
interface HandlerTeachThread {
  summarizeThread(input: {
    client: SlackClient;
    channel: string;
    threadTs: string;
  }): Promise<{ question: string; answer: string } | null>;
}
interface HandlerSumThread {
  summarizeThreadForHelper(input: { client: SlackClient; channel: string; threadTs: string }): Promise<string | null>;
}
interface HandlerRateLimit {
  check(input: object, options: object): { allowed: boolean; reason?: string };
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

const context = contextModule as HandlerContext;
const vision = visionModule as HandlerVision;
const respond = respondModule as HandlerRespond;
const learn = learnModule as HandlerLearn;
const teachThread = teachThreadModule as HandlerTeachThread;
const sumThread = sumThreadModule as HandlerSumThread;
const db = dbModule as HandlerDb;
const rateLimit = rateLimitModule as HandlerRateLimit;
const programs = programsModule as HandlerPrograms;
const macros: HandlerMacros = macrosModule as HandlerMacros;
const channelPolicy = channelPolicyModule as HandlerPolicy;
const workspace = workspaceModule as HandlerWorkspace;
const { stagingBlocked } = slackEventPolicy;
// event.item channel

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsOrryByName(text: string): boolean {
  const customNames = ((process.env.ORRY_BOT_ALIASES ?? process.env.RIVET_BOT_ALIASES) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const names = [...new Set([brand.name(), brand.slug(), ...customNames])];
  const pattern = require("./eligibility").botNamePattern(names);
  return new RegExp(`\\b(?:${pattern})\\w*\\b`, "i").test(text || "");
}

function teachPattern(mentionOnly = false): RegExp {
  const slug = escapeRegex(brand.slug());
  const base = mentionOnly
    ? `teach|learn|remember|memorize|!teach|/${slug}-teach`
    : `!teach|${slug}-teach|/${slug}-teach|teach\\s+this|teach\\s+thread`;
  return new RegExp(`^\\s*(?:${base})\\b`, "i");
}

function stripTeachCommand(text: string, mentionOnly = false): string {
  return String(text || "")
    .replace(teachPattern(mentionOnly), "")
    .trim();
}

function actorRunsCommands(userId: string, prog: Program | null): boolean {
  return isAdmin(userId) || (!!prog && db.isHelper(prog.id, userId));
}

function sumPattern(mentionOnly = false): RegExp {
  const slug = escapeRegex(brand.slug());
  const base = mentionOnly
    ? `sum|summary|summarize|summarise|!sum|!summary|!summarize|!summarise|/${slug}-sum`
    : `!sum|!summary|!summarize|!summarise|${slug}-sum|/${slug}-sum|sum\\s+this|sum\\s+thread|summarize\\s+thread|summarise\\s+thread`;
  return new RegExp(`^\\s*(?:${base})\\b`, "i");
}

function mentionsOrryDirectly(text: string): boolean {
  return require("./eligibility").directMention(text, config.slack.botUserId);
}

function stripBotMention(text: string): string {
  return require("./eligibility").stripBotMention(text, config.slack.botUserId);
}

function isDirectMessage(event: HandlerEvent): boolean {
  return event.channel_type === "im";
}

const DM_RATE_LIMIT_NOTICE = "woah slow down a sec — gimme a minute to catch up :pls:";

async function checkDmRateLimit({
  event,
  client,
  program = null,
  threadTs = null,
}: HandlerArgs & { program?: Program | null; threadTs?: string | null }): Promise<boolean> {
  if (!isDirectMessage(event)) return true;

  const limit = rateLimit.check({ userId: event.user || null, scope: event.channel, dm: true }, { dm: true });
  if (limit.allowed) return true;

  db.recordMetric("rate_limited", null, limit.reason || "limit", program?.id || null);
  if (!program || !program.shadowMode) {
    await require("./slackMessages").sendProgramMessage({
      client,
      program,
      channel: event.channel,
      threadTs,
      text: DM_RATE_LIMIT_NOTICE,
    });
  }
  return false;
}

function findImage(event: HandlerEvent): SlackFile | null {
  if (!event.files?.length) return null;
  return event.files.find((f: SlackFile) => f.mimetype?.startsWith("image/") && f.url_private) || null;
}

async function handleImage({ event, client, imageFile, program = null }: ImageArgs): Promise<boolean | void> {
  const threadTs = event.thread_ts || event.ts;
  const question = stripBotMention(event.text);

  if (!(await checkDmRateLimit({ event, client, program, threadTs }))) return false;

  try {
    context.addToThread(threadTs, "user", `[uploaded image] ${question}`, event.user, event.channel);
    const docs = question ? require("./knowledge").getContext(question, program?.id || null) : "";
    const reply = await vision.analyzeImage(
      imageFile.url_private,
      question,
      context.getThreadContext(threadTs),
      config.slack.botToken,
      docs,
      Boolean(
        program?.requireGroundedAnswer ||
        (process.env.ORRY_REQUIRE_GROUNDED_ANSWER ?? process.env.RIVET_REQUIRE_GROUNDED_ANSWER) === "1",
      ),
    );

    const requiresGrounding = Boolean(
      program?.requireGroundedAnswer ||
      (process.env.ORRY_REQUIRE_GROUNDED_ANSWER ?? process.env.RIVET_REQUIRE_GROUNDED_ANSWER) === "1",
    );
    const groundedReply = reply && requiresGrounding ? vision.groundedImageReply(reply, question, docs) : reply;
    if (reply && requiresGrounding && !groundedReply) {
      db.recordMetric("silent", null, "vision_ungrounded", program?.id || null);
      return;
    }

    if (groundedReply) {
      await require("./slackMessages").sendProgramMessage({
        client,
        program,
        channel: event.channel,
        threadTs,
        text: replyText.plainDashes(groundedReply),
      });
      context.addToThread(threadTs, "assistant", groundedReply, null, event.channel);
      context.updateUserHistory(event.user, question || "image analysis", true);
      db.recordMetric("answer_vision");
    } else {
      db.recordMetric("silent", null, "vision_skip", program?.id || null);
    }
  } catch (e: unknown) {
    log.error("vision", "analysis failed:", errorMessage(e));
    if (!program || !program.shadowMode) {
      await require("./slackMessages").sendProgramMessage({
        client,
        program,
        channel: event.channel,
        threadTs,
        text: replyText.plainDashes(respond.ERROR_FALLBACK),
      });
    }
  }
}

async function untaggedThreadTurn({ event, client }: HandlerArgs): Promise<string> {
  const crowd = await context.fetchThreadCrowd(client, {
    channel: event.channel,
    threadTs: event.thread_ts,
    messageTs: event.ts,
    userId: event.user,
    botUserId: String(config.slack.botUserId),
    parentUserId: event.parent_user_id || null,
  });
  if (crowd.othersPresent) return "humans_talking";
  return crowd.orryIn ? "addressed" : "ambient";
}

function stayOutOfHumanThread({
  event,
  threadTs,
  question,
  prog,
}: {
  event: HandlerEvent;
  threadTs: string;
  question: string;
  prog: Program;
}): void {
  log.debug("intent", "skipping thread reply — other people are talking and nobody called orry");
  context.addToThread(threadTs, "user", question, event.user, event.channel);
  db.recordMetric("silent", null, "thread_humans_talking", prog.id);
}

// Crisis text for this program's configured resources.
function crisisReplyFor(prog: Program): string {
  return require("./crisisReply").buildCrisisReply(prog.crisisResources);
}

// Sends the crisis text in-thread, adds it to thread history and records the fallback.
async function sendCrisisReply({
  client,
  prog,
  event,
  threadTs,
  text,
}: {
  client: SlackClient;
  prog: Program;
  event: HandlerEvent;
  threadTs: string;
  text: string;
}): Promise<void> {
  await require("./slackMessages").sendProgramMessage({
    client,
    program: prog,
    channel: event.channel,
    threadTs,
    text: replyText.plainDashes(text),
  });
  context.addToThread(threadTs, "assistant", text, null, event.channel);
  db.recordMetric("fallback", null, "self_harm_crisis_reply", prog.id);
}

// Self-harm gets a supportive in-thread reply, never the generic refusal line.
// It is sent whether or not the bot was addressed: a person in distress always gets a reply.
async function postCrisisReply({
  client,
  prog,
  event,
  threadTs,
}: {
  client: SlackClient;
  prog: Program;
  event: HandlerEvent;
  threadTs: string;
}): Promise<void> {
  const text = crisisReplyFor(prog);
  try {
    await sendCrisisReply({ client, prog, event, threadTs, text });
  } catch (e: unknown) {
    log.warn("handlers", `crisis reply failed: ${errorMessage(e)}`);
  }
}

// Opens the sensitive-escalation ticket when allowed; a failure is logged and leaves no ticket.
async function escalateToTicket({
  event,
  client,
  prog,
  workspaceId,
  threadTs,
  question,
  allowTicket,
}: {
  event: HandlerEvent;
  client: SlackClient;
  prog: Program;
  workspaceId: string | null;
  threadTs: string;
  question: string;
  allowTicket: boolean;
}): Promise<unknown> {
  let ticket = null;
  try {
    if (allowTicket) {
      ticket = await require("./tickets").escalateTicket({
        program: prog,
        channel: event.channel,
        threadTs,
        requesterId: event.user,
        question,
        client,
        workspaceId,
      });
    }
  } catch (e: unknown) {
    log.warn("handlers", `sensitive escalation ticket failed: ${errorMessage(e)}`);
  }
  return ticket;
}

// A ticket exists: self-harm still gets the crisis reply, and the event is logged as silent.
async function closeTicketedEscalation({
  client,
  prog,
  event,
  threadTs,
  selfHarm,
}: {
  client: SlackClient;
  prog: Program;
  event: HandlerEvent;
  threadTs: string;
  selfHarm: boolean;
}): Promise<void> {
  const elig = require("./eligibility");
  if (selfHarm) await postCrisisReply({ client, prog, event, threadTs });
  db.recordMetric("silent", null, `eligibility:${selfHarm ? elig.SELF_HARM : "sensitive_escalation"}`, prog.id);
}

// Pings a helper about the thread; a failed ping is logged and yields no helper.
async function handOffQuietly({
  client,
  prog,
  event,
  threadTs,
  question,
  workspaceId,
}: {
  client: SlackClient;
  prog: Program;
  event: HandlerEvent;
  threadTs: string;
  question: string;
  workspaceId: string | null;
}): Promise<unknown> {
  let helper = null;
  try {
    helper = await require("./tickets").handOffToHelper({
      client,
      program: prog,
      channel: event.channel,
      threadTs,
      question,
      requesterId: event.user,
      workspaceId,
    });
  } catch (e: unknown) {
    log.warn("handlers", `sensitive escalation helper ping failed: ${errorMessage(e)}`);
  }
  return helper;
}

// Picks the refusal wording; a helper ping switches to the "pinged" variant.
function refusalTextFor(question: string, helper: unknown, prog: Program): string {
  const refusal = require("./refusalReply");
  const reason = refusal.refusalReason(question);
  return helper ? refusal.pingedRefusalText(reason, { program: prog }) : refusal.refusalText(reason, { program: prog });
}

// Sends the refusal in-thread, logs it without the sensitive text, and records it as a fallback.
async function sendSensitiveRefusal({
  client,
  prog,
  event,
  threadTs,
  text,
}: {
  client: SlackClient;
  prog: Program;
  event: HandlerEvent;
  threadTs: string;
  text: string;
}): Promise<void> {
  await require("./slackMessages").sendProgramMessage({
    client,
    program: prog,
    channel: event.channel,
    threadTs,
    text: replyText.plainDashes(text),
    // The log must not become a list of sensitive threads with their text.
    logSource: "sensitive_reply",
    logPrivate: true,
  });
  context.addToThread(threadTs, "assistant", text, null, event.channel);
  db.recordMetric("fallback", null, "sensitive_unticketed", prog.id);
}

// No ticket: self-harm gets the crisis reply, unaddressed messages stay silent, the rest get a refusal.
async function answerUnticketed({
  client,
  prog,
  event,
  threadTs,
  question,
  addressed,
  selfHarm,
  helper,
}: {
  client: SlackClient;
  prog: Program;
  event: HandlerEvent;
  threadTs: string;
  question: string;
  addressed: boolean;
  selfHarm: boolean;
  helper: unknown;
}): Promise<void> {
  if (selfHarm) {
    await postCrisisReply({ client, prog, event, threadTs });
    return;
  }
  if (!addressed) {
    db.recordMetric("silent", null, "eligibility:sensitive_escalation", prog.id);
    return;
  }
  const text = refusalTextFor(question, helper, prog);
  await sendSensitiveRefusal({ client, prog, event, threadTs, text });
}

async function escalateSensitive({
  event,
  client,
  prog,
  workspaceId,
  threadTs,
  question,
  addressed,
  allowTicket = true,
}: {
  event: HandlerEvent;
  client: SlackClient;
  prog: Program;
  workspaceId: string | null;
  threadTs: string;
  question: string;
  addressed: boolean;
  allowTicket?: boolean;
}): Promise<void> {
  db.recordGap(question, event.user, event.channel, threadTs, prog.id);
  const ticket = await escalateToTicket({ event, client, prog, workspaceId, threadTs, question, allowTicket });
  const elig = require("./eligibility");
  const selfHarm = elig.selfHarmHit(question) || elig.selfHarmHit(event.text || "");
  if (ticket) {
    await closeTicketedEscalation({ client, prog, event, threadTs, selfHarm });
    return;
  }
  const helper = await handOffQuietly({ client, prog, event, threadTs, question, workspaceId });
  await answerUnticketed({ client, prog, event, threadTs, question, addressed, selfHarm, helper });
}

function threadRequiresMention(prog: Program | null): boolean {
  return (
    (process.env.ORRY_THREAD_REQUIRE_MENTION ?? process.env.RIVET_THREAD_REQUIRE_MENTION) === "1" ||
    Boolean((prog as (Program & { threadRequireMention?: boolean }) | null)?.threadRequireMention)
  );
}

function shouldConsiderThreadReply(
  event: HandlerEvent,
  prog: Program | null = null,
  workspaceId: string | null = null,
): boolean {
  if (!event.thread_ts || event.thread_ts === event.ts) return true;
  if (db.isThreadMuted(event.thread_ts)) {
    return mentionsOrryDirectly(event.text);
  }
  if (mentionsOrryByName(event.text) || mentionsOrryDirectly(event.text)) return true;
  if (threadRequiresMention(prog)) return false;
  const ticket = db.getTicketByThreadTs(event.thread_ts, workspaceId);
  if (ticket && !["resolved", "closed"].includes(ticket.status)) return true;
  return context.hasSpokenInThread(event.thread_ts);
}

function checkEligibility({
  event,
  prog,
  workspaceId,
  threadTs,
  question,
  isDm,
}: {
  event: HandlerEvent;
  prog: Program;
  workspaceId: string | null;
  threadTs: string;
  question: string;
  isDm: boolean;
}): string {
  const elig = require("./eligibility");
  const isTopLevel = !event.thread_ts || event.thread_ts === event.ts;
  let ticketOpen = false;
  try {
    const ticket = event.thread_ts ? db.getTicketByThreadTs(event.thread_ts, workspaceId) : null;
    ticketOpen = !!ticket && !["resolved", "closed"].includes(ticket.status);
  } catch (e: unknown) {
    log.debug("handlers", `ticket lookup in eligibility: ${errorMessage(e)}`);
  }
  const decision = elig.shouldOrryRespond({
    text: question,
    userId: event.user,
    botUserId: config.slack.botUserId,
    botNames: [brand.name(), brand.slug()],
    isHelpChannel: channelPolicy.resolve(event.channel, workspaceId).role === "help",
    isTopLevel,
    isDM: isDm,
    posture: prog.posture,
    program: prog,
    thread: event.thread_ts
      ? {
          muted: db.isThreadMuted(event.thread_ts),
          takeover: db.isTakeover(event.thread_ts),
          orrySpoke: context.hasSpokenInThread(event.thread_ts),
          ticketOpen,
        }
      : null,
    actorIsHelper: isAdmin(event.user),
  });

  if (decision.clearMute && event.thread_ts) db.unmuteThread(event.thread_ts);
  if (decision.clearTakeover && event.thread_ts) db.clearTakeover(event.thread_ts);
  if (decision.markTakeover && event.thread_ts) {
    db.markTakeover(event.thread_ts, event.channel, event.user);
    try {
      require("./audit").record({
        programId: prog.id,
        actorId: event.user,
        action: "thread.takeover",
        entityType: "thread",
        entityId: event.thread_ts,
      });
    } catch (e: unknown) {
      log.debug("handlers", `takeover audit failed: ${errorMessage(e)}`);
    }
  }

  if (decision.decision === elig.SILENT) {
    if (mentionsOrryDirectly(question) || mentionsOrryByName(question)) return "proceed";
    db.recordMetric("silent", null, `eligibility:${decision.reason}`, prog.id);
    return "stop";
  }
  if (decision.decision === elig.HUMAN_DEFER) {
    db.recordMetric("silent", null, `eligibility:${decision.reason}`, prog.id);
    if (channelPolicy.resolve(event.channel, workspaceId).role === "help") return "escalate";
    return "stop";
  }
  if (decision.decision === elig.ESCALATE) return "escalate";
  return "proceed";
}

async function ensureTopLevelHelpTicket({
  event,
  client,
  workspaceId,
  prog,
  role,
}: {
  event: HandlerEvent;
  client: SlackClient;
  workspaceId: string | null;
  prog: Program | null;
  role: string;
}): Promise<void> {
  if (role !== "help" || (event.thread_ts && event.thread_ts !== event.ts) || !prog) return;
  try {
    await require("./tickets").ensureSupportTicket({
      program: prog,
      channel: event.channel,
      threadTs: event.ts,
      requesterId: event.user,
      question: (event.text || "").trim(),
      client,
      workspaceId,
      role: "help",
      source: "help_channel_message",
    });
  } catch (error: unknown) {
    log.warn("tickets", `help-channel ticket creation failed for ${event.channel}/${event.ts}: ${errorMessage(error)}`);
  }
}

async function refuseUnauthorizedCommand({
  event,
  client,
  question,
  prog,
  policy,
}: {
  event: HandlerEvent;
  client: SlackClient;
  question: string;
  prog: Program;
  policy: ProgramPolicy;
}): Promise<boolean> {
  const commandRegistry = require("./commandRegistry");
  const hit = commandRegistry.match(question, {
    botUserId: config.slack.botUserId,
    botNames: [brand.name(), brand.slug()],
  });
  if (!hit) return false;
  const verdict = commandRegistry.authorize(hit.command, {
    userId: event.user,
    isHelper: actorRunsCommands(event.user, prog),
    isOrganizer: isAdmin(event.user),
    role: policy.role,
    commandsEnabled: policy.role === "main" ? policy.settings?.commandsEnabled !== false : true,
  });
  if (verdict.ok) return false;
  db.claimMessage(event.ts, event.channel);
  const text =
    verdict.reason === "commands_disabled"
      ? "commands are switched off in this channel :ban:"
      : verdict.reason === "wrong_channel"
        ? "that command doesn't work in this channel :ban:"
        : "that one's helpers-only :ban:";
  await client.chat.postEphemeral({ channel: event.channel, user: event.user, text });
  return true;
}

async function handleTeachRequest({
  event,
  client,
  question,
  prog,
  mentionOnly,
  claimFirst,
}: {
  event: HandlerEvent;
  client: SlackClient;
  question: string;
  prog: Program;
  mentionOnly: boolean;
  claimFirst: boolean;
}): Promise<boolean> {
  if (!event.thread_ts || !teachPattern(mentionOnly).test(question)) return false;
  if (!actorRunsCommands(event.user, prog)) {
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      text: "that one's helpers-only :ban:",
    });
    return true;
  }
  if (!(await checkDmRateLimit({ event, client, program: prog, threadTs: event.thread_ts }))) return true;
  if (claimFirst && !db.claimMessage(event.ts, event.channel)) return true;

  const strippedCommand = stripTeachCommand(question, mentionOnly);
  const parsedDirect = learn.parseTeach(strippedCommand);
  if (parsedDirect) {
    const id = learn.teach({
      ...parsedDirect,
      authorId: event.user,
      threadTs: event.thread_ts,
      channel: event.channel,
      programId: prog.id,
    });
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: event.thread_ts,
      text: id
        ? `🧚 Memorized for future questions! :yesyes:\n>*Q:* ${parsedDirect.question}\n>*A:* ${parsedDirect.answer}\n\n_#${id} — remove with \`${brand.cmd("forget")} ${id}\`_`
        : "already memorized or couldn't save it",
    });
    return true;
  }

  try {
    const parsed = await teachThread.summarizeThread({ client, channel: event.channel, threadTs: event.thread_ts });
    if (!parsed) {
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        thread_ts: event.thread_ts,
        text: "couldn't find a clear question and answer in this thread to memorize",
      });
      return true;
    }
    const id = learn.teach({
      ...parsed,
      authorId: event.user,
      threadTs: event.thread_ts,
      channel: event.channel,
      programId: prog.id,
    });
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: event.thread_ts,
      text: id
        ? `🧚 Memorized this thread for future questions! :yesyes:\n>*Q:* ${parsed.question}\n>*A:* ${parsed.answer}\n\n_#${id} — remove with \`${brand.cmd("forget")} ${id}\`_`
        : "already memorized this thread!",
    });
    return true;
  } catch (e: unknown) {
    log.error(
      "handlers",
      mentionOnly ? `teach thread on mention failed: ${errorMessage(e)}` : `!teach failed: ${errorMessage(e)}`,
    );
    return false;
  }
}

async function handleSumRequest({
  event,
  client,
  question,
  prog,
  mentionOnly,
  claimFirst,
}: {
  event: HandlerEvent;
  client: SlackClient;
  question: string;
  prog: Program;
  mentionOnly: boolean;
  claimFirst: boolean;
}): Promise<boolean> {
  if (!sumPattern(mentionOnly).test(question)) return false;
  if (!actorRunsCommands(event.user, prog)) {
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      text: "that one's helpers-only :ban:",
    });
    return true;
  }
  if (!(await checkDmRateLimit({ event, client, program: prog, threadTs: event.thread_ts }))) return true;
  if (!event.thread_ts) {
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      text: "!sum can only be used inside a thread :ban:",
    });
    return true;
  }
  if (claimFirst && !db.claimMessage(event.ts, event.channel)) return true;

  const isPublic = /\b(?:public|share|all|post)\b/i.test(question);
  try {
    const summary = await sumThread.summarizeThreadForHelper({
      client,
      channel: event.channel,
      threadTs: event.thread_ts,
    });

    if (!summary) {
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        thread_ts: event.thread_ts,
        text: "couldn't generate a summary for this thread",
      });
      return true;
    }

    const formatted = replyText.plainDashes(summary);
    if (isPublic) {
      const payload = {
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: `🧵 *Thread Summary* (requested by <@${event.user}>):\n\n${formatted}`,
      };
      const res = await client.chat.postMessage(payload);
      require("./outboundLog").recordSent(payload, res, "thread_summary");
    } else {
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        thread_ts: event.thread_ts,
        text: `🧵 *Thread Summary for Helpers:*\n\n${formatted}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `🧵 *Thread Summary for Helpers:*\n\n${formatted}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "📢 Post to Thread" },
                action_id: "sum_post_to_thread",
                value: JSON.stringify({
                  threadTs: event.thread_ts,
                  channel: event.channel,
                  summary: formatted.slice(0, 1500),
                }),
              },
            ],
          },
        ],
      });
    }
    return true;
  } catch (e: unknown) {
    log.error(
      "handlers",
      mentionOnly ? `sum on mention failed: ${errorMessage(e)}` : `!sum failed: ${errorMessage(e)}`,
    );
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: event.thread_ts,
      text: "failed to summarize the thread, check logs",
    });
    return true;
  }
}

const MACRO_NOTE_MAX_LENGTH = 280;

function parseMacroTrigger(text: string): MacroTrigger | null {
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(String(text || "").trim());
  if (!match) return null;
  const trigger = macros.normalizeTrigger(match[1]);
  if (!trigger || (match[2] && match[2].trim().length > MACRO_NOTE_MAX_LENGTH)) return null;
  return { trigger };
}

function findMacro(programId: string, trigger: string): MacroRow | null {
  const bare = trigger.slice(1);
  const candidates = macros.list(programId).filter((row: MacroRow) => String(row.trigger || "").slice(1) === bare);
  return (
    candidates.find((row: MacroRow) => row.trigger === trigger && row.enabled) ||
    candidates.find((row: MacroRow) => row.enabled) ||
    candidates[0] ||
    null
  );
}

async function postMacroEphemeral(client: SlackClient, event: HandlerEvent, text: string): Promise<void> {
  try {
    await client?.chat?.postEphemeral?.({ channel: event.channel, user: event.user, thread_ts: event.thread_ts, text });
  } catch (e: unknown) {
    log.debug("macros", `ephemeral failed for ${event.ts}: ${errorMessage(e)}`);
  }
}

function macroTargetFor(event: HandlerEvent, workspaceId: string | null): TicketTarget {
  let ticket = db.getTicketByThreadTs(event.thread_ts, workspaceId);
  if (!ticket && workspaceId) ticket = db.getTicketByThreadTs(event.thread_ts);
  const foreign =
    ticket &&
    (ticket.channel !== event.channel || (ticket.workspace_id && workspaceId && ticket.workspace_id !== workspaceId));
  if (ticket && !foreign) return { ticket, program: programs.get(ticket.program_id) };
  const program = programs.forChannel(event.channel, workspaceId);
  if (!program || program.id === programs.shared().id) return { ticket: null, program: null };
  return { ticket: null, program };
}

async function handleMacroTrigger({
  event,
  client,
  workspaceId,
}: HandlerArgs & { workspaceId: string | null }): Promise<boolean> {
  if (!event.thread_ts || event.thread_ts === event.ts || !event.user) return false;
  if (teachPattern(false).test(event.text) || sumPattern(false).test(event.text)) return false;
  const parsed = parseMacroTrigger(event.text);
  if (!parsed) return false;
  const { ticket, program } = macroTargetFor(event, workspaceId);
  if (!program) return false;
  const macro = findMacro(program.id, parsed.trigger);

  if (!actorRunsCommands(event.user, program)) {
    if (!macro || !macro.enabled) return false;
    if (!db.claimMessage(event.ts, event.channel)) return true;
    await postMacroEphemeral(client, event, "that one's helpers-only :ban:");
    return true;
  }

  if (!db.claimMessage(event.ts, event.channel)) return true;
  if (!macro || !macro.enabled) {
    const enabled = macros
      .list(program.id, { enabledOnly: true })
      .slice(0, 5)
      .map((row: MacroRow) => row.trigger);
    const suggestion = enabled.length > 0 ? enabled.join(", ") : "none yet, add one on the Macros page";
    await postMacroEphemeral(client, event, `No macro \`${parsed.trigger}\` for ${program.name}. Try: ${suggestion}`);
    return true;
  }

  const sent = ticket
    ? await macros.send({ id: macro.id, ticketId: ticket.id, actorId: event.user, client })
    : await macros.sendToThread({
        id: macro.id,
        program,
        channel: event.channel,
        threadTs: event.thread_ts,
        actorId: event.user,
        client,
      });
  if (!sent?.ok) {
    log.warn(
      "macros",
      `send failed for ${parsed.trigger} in ${event.channel}/${event.thread_ts}: ${sent?.error || "unknown error"}`,
    );
    await postMacroEphemeral(client, event, `Couldn't send \`${macro.trigger}\`: ${sent?.error || "unknown error"}`);
  }
  return true;
}

// channel ownership
async function onMessage({ event, client, body }: HandlerArgs): Promise<void> {
  if (event.bot_id || event.subtype === "bot_message" || event.user === config.slack.botUserId) return;
  if (stagingBlocked(event.channel)) return;

  // A participant deleting or editing their message: drop the stored copy.
  // Nothing is posted and the message is never answered.
  if (event.subtype === "message_deleted" || event.subtype === "message_changed") {
    require("./messageRedaction").handleMessageChange(event, workspace.workspaceOf(event, body));
    return;
  }

  const allowedSubtypes = ["file_share", "thread_broadcast"];
  if (event.subtype && !allowedSubtypes.includes(event.subtype)) return;

  const threadTs = event.thread_ts || event.ts;
  const question = (event.text || "").trim();
  const isDm = isDirectMessage(event);
  const named = mentionsOrryByName(question);
  const pinged = mentionsOrryDirectly(question);

  const workspaceId = workspace.workspaceOf(event, body);
  if (await handleMacroTrigger({ event, client, workspaceId })) return;
  let productionProgramMatch = null;
  try {
    const candidate = programs.forChannel(event.channel, workspaceId);
    if (candidate && candidate.id && candidate.id !== programs.shared().id) productionProgramMatch = candidate.id;
  } catch (error: unknown) {
    log.debug("draft", `production channel lookup failed: ${errorMessage(error)}`);
  }
  if (!productionProgramMatch) {
    let draftBinding = null;
    try {
      draftBinding = require("./draftSandbox").getForChannel(event.channel, workspaceId);
    } catch (e: unknown) {
      log.warn(
        "draft",
        `channel_id=${event.channel} message_ts=${event.ts} production_program_match=null draft_binding_match=error draft_safety_pass=false suppression_reason=binding_lookup_failed`,
      );
    }
    if (draftBinding && draftBinding.enabled) {
      const draftProgramId = draftBinding.draftProgramId;
      const baseLog = `channel_id=${event.channel} message_ts=${event.ts} production_program_match=null draft_binding_match=${draftBinding.role} draft_program_id=${draftProgramId}`;
      if (draftBinding.role !== "help") {
        log.info("draft", `${baseLog} draft_safety_pass=true suppression_reason=ticket_sink_no_answer`);
        return;
      }
      if (!question) {
        log.info("draft", `${baseLog} draft_safety_pass=true suppression_reason=empty_text`);
        return;
      }
      const draftProgram = require("./draftSandbox").get(draftProgramId);
      const safetyPass = Boolean(
        draftProgram &&
        draftProgram.status === "suspended" &&
        draftProgram.privateSandboxOnly === true &&
        draftProgram.autoAssign !== true,
      );
      if (!safetyPass) {
        log.warn("draft", `${baseLog} draft_safety_pass=false suppression_reason=safety_check_failed`);
        return;
      }
      if (!db.claimMessage(event.ts, event.channel)) return;
      try {
        const ticket = await require("./draftSandbox").ensureSupportTicket({
          programId: draftProgramId,
          workspaceId,
          channel: event.channel,
          threadTs,
          requesterId: event.user,
          question,
          client,
        });
        if (!ticket)
          log.warn("draft", `${baseLog} draft_safety_pass=true suppression_reason=sandbox_ticket_unavailable`);
      } catch (e: unknown) {
        log.warn("draft", `${baseLog} draft_safety_pass=true suppression_reason=sandbox_ticket_failed`);
      }
      let corpus = "";
      try {
        corpus = require("./knowledge").getDraftContext(draftProgramId, question);
      } catch (e: unknown) {
        log.warn("draft", `${baseLog} draft_safety_pass=true suppression_reason=retrieval_error`);
        return;
      }
      const retrievalCount = corpus ? corpus.length : 0;
      if (!corpus) {
        log.warn(
          "draft",
          `${baseLog} draft_safety_pass=true classification=support retrieval_count=0 suppression_reason=empty_corpus`,
        );
        return;
      }
      let answer = null;
      try {
        answer = await require("./answer").getGroundedAnswer(question, corpus, "", draftProgram, event.channel, {
          inHelpChannel: true,
        });
      } catch (e: unknown) {
        log.warn(
          "draft",
          `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=error suppression_reason=generation_failed`,
        );
        return;
      }
      if (!answer?.answer) {
        const draftName = draftProgram?.name || draftProgramId;
        const fallback = `I don't have that in the ${draftName} draft knowledge yet — I'm scoped to ${draftName} sources only in this sandbox.`;
        try {
          await require("./slackMessages").sendProgramMessage({
            client,
            program: draftProgram,
            channel: event.channel,
            threadTs,
            text: fallback,
          });
          log.info(
            "draft",
            `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=fallback slack_post_result=sent suppression_reason=no_grounded_answer`,
          );
        } catch (e: unknown) {
          log.warn(
            "draft",
            `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=fallback slack_post_result=failed suppression_reason=slack_post_failed`,
          );
        }
        return;
      }
      try {
        await require("./slackMessages").sendProgramMessage({
          client,
          program: draftProgram,
          channel: event.channel,
          threadTs,
          text: answer.answer,
        });
        log.info(
          "draft",
          `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=answered slack_post_result=sent`,
        );
      } catch (e: unknown) {
        log.warn(
          "draft",
          `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=answered slack_post_result=failed suppression_reason=slack_post_failed`,
        );
      }
      return;
    }
  }
  if (event.thread_ts && event.thread_ts !== event.ts && !event.bot_id) {
    try {
      await require("./tickets").noteThreadActivity({
        channel: event.channel,
        threadTs: event.thread_ts,
        userId: event.user,
        text: event.text || null,
        workspaceId,
        client,
        parentUserId: event.parent_user_id || null,
      });
    } catch (e: unknown) {
      log.debug("handlers", `thread activity tracking: ${errorMessage(e)}`);
    }
  }
  const policy = channelPolicy.resolve(event.channel, workspaceId, { isDm });
  const prog = policy.program;
  const inHelpChannel = policy.role === "help";
  const isProgChannel = policy.role === "main" || policy.role === "organizer";

  if (!isDm && !inHelpChannel && !isProgChannel) return;
  if (!isDm && policy.settings && policy.settings.enabled === false) return;

  await ensureTopLevelHelpTicket({ event, client, workspaceId, prog, role: policy.role });

  if (question) {
    db.recordUserMessage({ userId: event.user, channel: event.channel, threadTs, text: question });
  }

  log.debug(
    "message",
    `channel=${event.channel} dm=${isDm} thread=${event.thread_ts || "none"} ts=${event.ts} named=${named} pinged=${pinged} prog=${prog.id} posture=${prog.posture}`,
  );

  if (!event.bot_id && event.subtype !== "bot_message") {
    const elig = checkEligibility({ event, prog, workspaceId, threadTs, question, isDm });
    if (elig === "stop") {
      if (pinged) db.claimMessage(event.ts, event.channel);
      return;
    }
    if (elig === "escalate") {
      if (!db.claimMessage(event.ts, event.channel)) return;
      await escalateSensitive({
        event,
        client,
        prog,
        workspaceId,
        threadTs: event.thread_ts || event.ts,
        question,
        addressed: pinged || named || isDm,
      });
      return;
    }
  }

  if (await refuseUnauthorizedCommand({ event, client, question, prog, policy })) return;

  if (await handleTeachRequest({ event, client, question, prog, mentionOnly: false, claimFirst: true })) return;

  if (await handleSumRequest({ event, client, question, prog, mentionOnly: false, claimFirst: true })) return;

  const imageFile = findImage(event);
  if (imageFile) {
    const hasQuestion = question && question.trim().length > 0;
    const wanted = isDm || pinged || named || (inHelpChannel && hasQuestion);
    if (!wanted) return;
    if (!db.claimMessage(event.ts, event.channel)) return;
    await handleImage({ event, client, imageFile, program: prog });
    return;
  }

  if (pinged) {
    await onAppMention({ event, client, body });
    return;
  }

  if (isDm) {
    if (!(await checkDmRateLimit({ event, client, program: prog, threadTs: event.thread_ts || undefined }))) return;
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      workspaceId,
      client,
      channel: event.channel,
      threadTs: event.thread_ts || undefined,
      userId: event.user,
      question,
      messageTs: event.ts,
      mode: respond.ALWAYS,
      addressedHow: "dm",
      seedClient: event.thread_ts ? client : null,
      scope: event.channel,
      dm: true,
      rateLimitReserved: true,
    });
    return;
  }

  if (isProgChannel && !inHelpChannel) {
    if (named) {
      if (!db.claimMessage(event.ts, event.channel)) return;
      await respond.respond({
        workspaceId,
        client,
        channel: event.channel,
        threadTs,
        userId: event.user,
        question,
        messageTs: event.ts,
        mode: respond.ALWAYS,
        seedClient: client,
        addressed: true,
        addressedHow: "mention",
      });
      return;
    }

    if (!shouldConsiderThreadReply(event, prog, workspaceId)) {
      log.debug("intent", "skipping thread reply — orry not in this thread / not addressed");
      return;
    }

    if (!worthClassifying(question)) {
      log.debug("intent", "skipping model call — nothing but emoji or a bare reaction");
      context.addToThread(threadTs, "user", question, event.user, event.channel);
      db.recordMetric("silent", null, "no_content");
      return;
    }

    const turn = event.thread_ts ? await untaggedThreadTurn({ event, client }) : "ambient";
    if (turn === "humans_talking") return stayOutOfHumanThread({ event, threadTs, question, prog });
    const toOrry = turn === "addressed";
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      workspaceId,
      client,
      channel: event.channel,
      threadTs,
      userId: event.user,
      question,
      messageTs: event.ts,
      mode: toOrry ? respond.ALWAYS : respond.HELP_ONLY,
      addressed: toOrry,
      addressedHow: toOrry ? "thread" : undefined,
      seedClient: client,
    });
    return;
  }

  if (!inHelpChannel) return;

  if (event.thread_ts && !named) {
    if (!shouldConsiderThreadReply(event, prog, workspaceId)) {
      log.debug("intent", "skipping help thread reply — orry not in this thread / not addressed");
      return;
    }

    if (!worthClassifying(question)) {
      log.debug("intent", "skipping model call — nothing but emoji or a bare reaction");
      context.addToThread(threadTs, "user", question, event.user, event.channel);
      db.recordMetric("silent", null, "no_content");
      return;
    }

    const turn = await untaggedThreadTurn({ event, client });
    if (turn === "humans_talking") return stayOutOfHumanThread({ event, threadTs, question, prog });
    const toOrry = turn === "addressed";
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      workspaceId,
      client,
      channel: event.channel,
      threadTs,
      userId: event.user,
      question,
      messageTs: event.ts,
      mode: toOrry ? respond.ALWAYS : respond.HELP_ONLY,
      seedClient: client,
      addressed: toOrry,
      addressedHow: toOrry ? "thread" : undefined,
    });
    return;
  }

  if (!named && !worthClassifying(question)) {
    db.recordMetric("silent", null, "no_content");
    return;
  }

  if (!db.claimMessage(event.ts, event.channel)) return;
  await respond.respond({
    workspaceId,
    client,
    channel: event.channel,
    threadTs,
    userId: event.user,
    question,
    messageTs: event.ts,
    mode: named ? respond.ALWAYS : respond.HELP_ONLY,
    seedClient: client,
    addressed: named,
    addressedHow: named ? "mention" : undefined,
  });
}

// duplicate delivery
async function onAppMention({ event, client, body }: HandlerArgs): Promise<void> {
  if (event.bot_id || event.subtype === "bot_message" || event.user === config.slack.botUserId) return;
  if (stagingBlocked(event.channel)) return;
  const workspaceId = workspace.workspaceOf(event, body);
  const explicitWorkspaceId = workspace.explicitWorkspaceOf(event, body);
  const question = stripBotMention(event.text);
  const threadTs = event.thread_ts || event.ts;

  const policy = channelPolicy.resolve(event.channel, workspaceId);
  // A direct @-mention is explicit consent to reply, even in a channel the bot
  // otherwise ignores. Without this, mentions in report-only rooms like
  // #loadout-development die silently at the role gate below.
  const mentionedOutside = policy.role === "none";
  let prog = mentionedOutside ? programs.get("loadout") || programs.shared() : policy.program;
  if (mentionedOutside && prog?.workspaceId && (!explicitWorkspaceId || prog.workspaceId !== explicitWorkspaceId))
    prog = programs.shared();
  if (!mentionedOutside && !["help", "main", "organizer"].includes(policy.role)) return;
  if (!prog) return;
  const selectedSettings = mentionedOutside ? require("./programModel").behaviorFor(prog).main : policy.settings;
  const settings =
    selectedSettings && require("./programModel").statusFor(prog) === "paused"
      ? { ...selectedSettings, enabled: false }
      : selectedSettings;
  if (settings && settings.enabled === false) return;

  if (db.wasAnswered(event.ts)) return;
  await ensureTopLevelHelpTicket({ event, client, workspaceId, prog, role: policy.role });

  const directlyAddressed = mentionsOrryDirectly(event.text) || mentionsOrryByName(event.text);
  if (event.thread_ts && (db.isThreadMuted(event.thread_ts) || db.isTakeover(event.thread_ts)) && !directlyAddressed) {
    const elig = require("./eligibility");
    const verdict = elig.shouldOrryRespond({
      text: event.text,
      userId: event.user,
      botUserId: config.slack.botUserId,
      botNames: [brand.name(), brand.slug()],
      isHelpChannel: policy.role === "help",
      isTopLevel: false,
      posture: prog.posture,
      program: prog,
      thread: {
        muted: db.isThreadMuted(event.thread_ts),
        takeover: db.isTakeover(event.thread_ts),
        orrySpoke: context.hasSpokenInThread(event.thread_ts),
        ticketOpen: false,
      },
    });
    if (verdict.decision !== elig.REPLY) {
      db.recordMetric("silent", null, `eligibility:${verdict.reason}`, prog.id);
      return;
    }
    if (verdict.clearMute) db.unmuteThread(event.thread_ts);
    if (verdict.clearTakeover) db.clearTakeover(event.thread_ts);
  }

  if (!db.claimMessage(event.ts, event.channel)) return;

  const eligibility = checkEligibility({
    event,
    prog,
    workspaceId,
    threadTs,
    question: event.text || "",
    isDm: false,
  });
  if (eligibility === "stop") return;
  if (eligibility === "escalate") {
    await escalateSensitive({
      event,
      client,
      prog,
      workspaceId,
      threadTs,
      question,
      addressed: true,
      allowTicket: !mentionedOutside,
    });
    return;
  }

  if (await refuseUnauthorizedCommand({ event, client, question: event.text || "", prog, policy })) return;

  if (await handleTeachRequest({ event, client, question, prog, mentionOnly: true, claimFirst: false })) return;

  if (await handleSumRequest({ event, client, question, prog, mentionOnly: true, claimFirst: false })) return;

  const imageFile = findImage(event);
  if (imageFile) {
    await handleImage({ event, client, imageFile, program: prog });
    return;
  }

  await respond.respond({
    workspaceId,
    client,
    channel: event.channel,
    threadTs,
    userId: event.user,
    question,
    messageTs: event.ts,
    mode: respond.ALWAYS,
    seedClient: client,
    addressed: true,
    addressedHow: "mention",
    program: prog,
    programSettings: settings,
  });
}

export = {
  onMessage,
  onAppMention,
  onReactionAdded: reactionHandlers.onReactionAdded,
  onReactionRemoved: reactionHandlers.onReactionRemoved,
  shouldConsiderThreadReply,
  mentionsOrryByName,
  mentionsOrryDirectly,
  stripBotMention,
  findImage,
  handleImage,
  handleTeachRequest,
  handleSumRequest,
  teachPattern,
  sumPattern,
  checkDmRateLimit,
};
