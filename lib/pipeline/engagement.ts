const jevDecision = require("../jevDecision");
const veyDecision = require("../veyDecision");
const intent = require("../intent");
const log = require("../log");
import type { ChannelRole } from "../types";

interface RecentMessage {
  text?: string;
  speaker?: string;
  userId?: string | null;
}
interface EngagementContext {
  message: string;
  program: unknown;
  userId?: string | null;
  channel?: string | null;
  addressed?: boolean;
  threadMessages?: unknown[];
  recentMessages?: RecentMessage[];
}
interface JEVResult {
  action?: string;
  errorKind?: string;
  intent?: string;
  decision?: { intent?: string };
}

function isIdentityOrSmalltalk(text: string) {
  const t = String(text || "")
    .replace(/^<@[^>]+>\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/[?!.,]+$/g, "")
    .trim();
  if (!t) return false;
  if (/\bwho\s*(are|r)\s*(u|you)\b/.test(t)) return true;
  if (/\bwhat\s*(are|r)\s*(u|you)\b/.test(t)) return true;
  if (/\b(your|ur)\s*name\b/.test(t)) return true;
  if (/\babout\s*(yourself|you|u)\b/.test(t)) return true;
  if (/\bwho\s*(made|created|built)\s*(you|u)\b/.test(t)) return true;
  if (/^(hi+|hello+|hey+|yo|sup|thanks?|thx|ty|gm|gn|morning)\b/.test(t) && t.split(/\s+/).length <= 3) return true;
  return false;
}

function isProgramPeopleQuestion(text: string) {
  return /\bwho\b[^.!?\n]{0,60}\b(?:org(?:anizers?|anisation|anization)?|organis(?:er|ers|e|es|ing)|organizes?|leads?|runs?|behind|made|built|created)\b/i.test(
    String(text || "")
      .replace(/^<@[^>]+>\s*/, "")
      .trim(),
  );
}

function postureFor(role: ChannelRole) {
  if (role === "help") return "help";
  if (role === "dm") return "dm";
  return "main";
}

function fromDecision(res: JEVResult | null, source: "jev" | "vey") {
  if (!res) return { engage: false, intent: null, error: "unknown", source };
  if (res.action === "error" || res.errorKind) {
    return { engage: false, intent: null, error: res.errorKind || "unknown", source };
  }
  const intentName = res.intent || res.decision?.intent || null;
  return { engage: res.action === "engage", intent: intentName, error: null, source };
}

function fromJev(res: JEVResult | null) {
  return fromDecision(res, "jev");
}

async function fromLegacyIntent({
  message,
  program,
  userId,
  channel,
  addressed,
  threadMessages,
  recentMessages,
}: EngagementContext) {
  const result = await intent
    .classifyIntentContext(message, program, { userId, channel, addressed, threadMessages, recentMessages })
    .catch(() => null);
  if (!result) return { engage: false, intent: null, error: "unavailable", source: "intent" };
  // The verdict decides whether this is a program question. directedAtHuman is
  // a secondary signal and must not override it: a message can be a real
  // question aimed at a human *and* something Rivet can answer. Checking it
  // first silenced every such message, and the resulting log line reported
  // intent "human_conversation" - which reads as a classifier failure when the
  // classifier had in fact returned HELP_NEEDED.
  if (result.verdict === intent.HELP_NEEDED)
    return { engage: true, intent: "support_question", error: null, source: "intent" };
  if (result.directedAtHuman) return { engage: false, intent: "human_conversation", error: null, source: "intent" };
  if (result.verdict === intent.OFF_TOPIC)
    return { engage: false, intent: "unrelated_chatter", error: null, source: "intent" };
  return {
    engage: false,
    intent: addressed ? "addressed_smalltalk" : "human_conversation",
    error: null,
    source: "intent",
  };
}

const RECENT_LINE_CHARS = 200;

function formatRecent(recentMessages: RecentMessage[] = [], userId: string | null | undefined) {
  return (recentMessages || [])
    .filter((m) => m && m.text)
    .map((m) => {
      const who = m.speaker === "rivet" ? "rivet" : userId && m.userId === userId ? "same sender" : "other member";
      return `${who}: ${String(m.text).replace(/\s+/g, " ").slice(0, RECENT_LINE_CHARS)}`;
    })
    .join("\n");
}

function conversationContextFor({
  threadContext,
  recentMessages,
  userId,
}: {
  threadContext?: string;
  recentMessages?: RecentMessage[];
  userId?: string | null;
}) {
  const recent = formatRecent(recentMessages, userId);
  return [recent && `Recent channel messages:\n${recent}`, threadContext && `Thread:\n${threadContext}`]
    .filter(Boolean)
    .join("\n\n");
}

interface ClassifyOptions extends EngagementContext {
  threadContext?: string;
  role: ChannelRole;
}

async function classify({
  message,
  threadContext = "",
  program,
  role,
  addressed = false,
  userId = null,
  channel = null,
  threadMessages = [],
  recentMessages = [],
}: ClassifyOptions) {
  if (addressed && isIdentityOrSmalltalk(message)) {
    return { engage: true, intent: "addressed_smalltalk", error: null, source: "heuristic" };
  }
  if (isProgramPeopleQuestion(message)) {
    return { engage: true, intent: "support_question", error: null, source: "heuristic" };
  }
  if (veyDecision.isEnabled()) {
    try {
      const res = await veyDecision.evaluateSupportDecision({
        message,
        conversationContext: conversationContextFor({ threadContext, recentMessages, userId }),
        program,
        channelPosture: postureFor(role),
        addressed,
      });
      if (res && res.action !== "existing") return fromDecision(res, "vey");
    } catch (error: unknown) {
      log.warn(
        "engagement",
        `vey threw (${error instanceof Error ? error.name : "Error"}); falling back to the next classifier`,
      );
    }
  }
  if (jevDecision.isEnabled()) {
    try {
      const res = await jevDecision.evaluateSupportDecision({
        message,
        conversationContext: conversationContextFor({ threadContext, recentMessages, userId }),
        program,
        channelPosture: postureFor(role),
        addressed,
      });
      if (res && res.action !== "existing") {
        const decision = fromJev(res);
        if (!decision.error) return decision;
        log.warn("engagement", `jev classifier failed (${decision.error}); falling back to legacy intent`);
      }
    } catch (error: unknown) {
      log.warn(
        "engagement",
        `jev threw (${error instanceof Error ? error.name : "Error"}); falling back to legacy intent`,
      );
    }
  }
  return fromLegacyIntent({ message, program, userId, channel, addressed, threadMessages, recentMessages });
}

export = { conversationContextFor, classify, isIdentityOrSmalltalk, fromJev };
