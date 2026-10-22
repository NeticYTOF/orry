import type { Program } from "./types";

type BotNameOptions = { botUserId?: string | null; botNames?: string[] };
interface ThreadState {
  muted?: boolean;
  takeover?: boolean;
  orrySpoke?: boolean;
  ticketOpen?: boolean;
}
interface EligibilityOptions {
  text?: string;
  userId?: string | null;
  botUserId?: string | null;
  botNames?: string[];
  isHelpChannel?: boolean;
  isTopLevel?: boolean;
  isDM?: boolean;
  posture?: string;
  program?: Program | null;
  thread?: ThreadState | null;
  actorIsHelper?: boolean;
}
interface EligibilityDecision {
  decision: string;
  reason: string;
  clearMute?: boolean;
  clearTakeover?: boolean;
  markTakeover?: boolean;
  fileTicket?: boolean;
  touchTicket?: boolean;
  noTicket?: boolean;
}
const REPLY = "reply";
const SILENT = "silent";
const ESCALATE = "escalate";
const HUMAN_DEFER = "human_defer";
const SELF_HARM = "self_harm";

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function botNamePattern(botNames: string[] = []): string {
  const names = [...new Set((botNames || []).filter(Boolean))].map(escapeRegex).join("|");
  return names || "orry";
}

function otherMentions(text: string, botUserId: string | null = null): string[] {
  const found = String(text || "").match(/<@[A-Z0-9]+(?:\|[^>]+)?>/g) || [];
  return found.filter((m) => !botUserId || !m.includes(botUserId));
}

function directMention(text: string, botUserId: string | null = null): boolean {
  return !!botUserId && String(text || "").includes(`<@${botUserId}>`);
}

function stripBotMention(text: string, botUserId: string | null = null): string {
  if (!botUserId) return String(text || "").trim();
  return String(text || "")
    .replace(new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]+)?>`, "g"), "")
    .trim();
}

function nameMentionAt(text: string, names: string[]): { token: string; index: number } | null {
  const m = String(text || "").match(new RegExp(`\\b(?:${botNamePattern(names)})\\w*\\b`, "i"));
  return m ? { token: m[0], index: m.index ?? -1 } : null;
}

function invocationAnalysis(
  text: string,
  { botUserId = null, botNames = [] }: BotNameOptions = {},
): { addressed: boolean; invocation: boolean; referential: boolean } {
  const body = String(text || "");
  const mentioned = directMention(body, botUserId);
  const named = nameMentionAt(body, botNames);
  if (!mentioned && !named) return { addressed: false, invocation: false, referential: false };

  const stripped = body.replace(/^[\s,.;:!?-]+/, "");
  const namePattern = botNamePattern(botNames);
  const referential =
    new RegExp(
      `\\b(ask|tell|ping|invite|thank|thanks|replace|blame|ignore|listen to)\\b[^.!?]{0,40}(?:\\b(?:${namePattern})\\w*|<@)`,
      "i",
    ).test(body) ||
    new RegExp(
      `\\b(?:${namePattern})\\w*\\s+(already\\s+)?(said|answered|replied|replies|thinks?|knows?|told)\\b`,
      "i",
    ).test(body) ||
    new RegExp(`\\breplace\\s+\\S+\\s+with\\s+(?:\\b(?:${namePattern})\\w*|<@)`, "i").test(body);
  if (referential) return { addressed: true, invocation: false, referential: true };
  const startsWithMention = !!botUserId && stripped.startsWith(`<@${botUserId}>`);
  const startsWithName = new RegExp(
    `^(?:hey|hi|hello|yo|please|pls)[\\s,]+|^\\b(?:${botNamePattern(botNames)})\\b`,
    "i",
  ).test(stripped);
  if (startsWithMention || startsWithName) return { addressed: true, invocation: true, referential: false };

  const anchorIndex = mentioned ? body.indexOf(`<@${botUserId}>`) : (named?.index ?? -1);
  const after = body.slice(anchorIndex, anchorIndex + 60);
  if (
    /(?:^|[\s,])(?:can|could|would|will|do|does|did|is|are|was|were|how|what|when|where|why|which|who|help|tell|show|give|find|check|explain|do you know|any idea|anyone know)\b/i.test(
      after,
    )
  ) {
    return { addressed: true, invocation: true, referential: false };
  }
  return { addressed: true, invocation: true, referential: false };
}

const DEFERRAL_RES = [
  /asking\s+\S+\s+specifically/i,
  /wait(?:ing)?\s+for\s+(?:<@|the\s+reviewers|the\s+helpers)/i,
  /\blet\s+(?:<@|[A-Z][a-z]+)\b/i,
  /\bleave\s+(?:this|that|it|this\s+one)\s+to\s+(?:<@|me\b)/i,
  /\bdefer\s+to\s+(?:<@|[A-Z])/i,
  /\bone\s+of\s+the\s+(?:reviewers|helpers|organizers|mods)\b/i,
  /(?:<@[A-Z0-9]+(?:\|[^>]+)?>|[A-Z][a-z]{2,})\s+(?:will|can)\s+answer\b/,
  /\b[a-z]{3,}\s+(?:will|can)\s+answer\s+(?:when|if|once|shortly|soon)\b/,
  /\b[Ss]pecifically\b.*<@/i,
];

function humanDirected(text: string, { botUserId = null }: { botUserId?: string | null } = {}): boolean {
  const body = String(text || "");
  const stripped = body.replace(/^[\s,.;:!?-]+/, "");
  if (/^(?:asking|waiting for|deferring to)\b/i.test(stripped)) return true;
  if (DEFERRAL_RES.some((re) => re.test(body))) return true;
  const others = otherMentions(body, botUserId);
  if (others.length === 0) return false;
  if (stripped.startsWith(others[0])) return true;
  const firstAt = body.indexOf(others[0]);
  const window = body.slice(Math.max(0, firstAt - 40), firstAt + 40);
  if (DEFERRAL_RES.some((re) => re.test(window))) return true;
  return false;
}

const TAKEOVER_RES = [
  /\bi(['’]ll| will) (handle|take|check|look into|look at|deal with|take care of) (this|that|it)\b/i,
  /\blet me (check|look|handle|take|see)\b/i,
  /\bwait for\s+(?:<@|me\b|him\b|her\b|them\b|[A-Z][a-z]+)/i,
  /\bleave (this|that|it|this one) to me\b/i,
  /\bone of the reviewers is checking\b/i,
  /(?:<@[A-Z0-9]+(?:\|[^>]+)?>|[A-Z][a-z]{2,}|[Ii])\s+(?:will|can)\s+answer\b/i,
  /\basking \S+ specifically\b/i,
  /\bi(['’]ll| will) take this\b/i,
  /\bi got this\b/i,
];

function takeoverCue(text: string, botNames: string[] = []): boolean {
  const body = String(text || "");
  const names = [...new Set(botNames || [])].map(escapeRegex).join("|");
  if (new RegExp(`asking\\s+(?:${names})\\w*\\s+specifically`, "i").test(body)) return false;
  return TAKEOVER_RES.some((re) => re.test(body));
}

const REACTIVATE_RES = [
  /\bcome back\b/i,
  /\bwake up\b/i,
  /\bunmute\b/i,
  /\bresume\b/i,
  /\bcontinue\b/i,
  /\bare you there\b/i,
  /\byou there\b/i,
  /^help\b/i,
  /\bhelp me\b/i,
];

function reactivationPhrase(text: string): boolean {
  return REACTIVATE_RES.some((re) => re.test(String(text || "")));
}

const GREETING_RES =
  /^(?:hi+|hello+|hey+|yo|sup|gg+|lol|lmao|haha+|hehe|lets? go+|lfg+|wooo+|yay+|test(?:ing)?|thanks?|thx|ok|who's there)\b/i;

function substantiveQuestion(text: string): boolean {
  const body = String(text || "")
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, " ")
    .trim();
  if (/\?/.test(body)) return true;
  if (
    /\b(?:how|what|when|where|why|which|who|whom|whose|can|could|would|should|is|are|was|were|does|do|did|will|has|have|any|help|explain|tell|show|need|want|looking for)\b/i.test(
      body,
    )
  )
    return true;
  return body.split(/\s+/).filter(Boolean).length > 6;
}

function greetingOrNoise(text: string): boolean {
  const body = String(text || "")
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, " ")
    .replace(/:[a-z0-9_+-]+:/gi, " ")
    .trim();
  if (!body) return true;
  if (/\?/.test(body) || substantiveQuestion(text)) return false;
  if (GREETING_RES.test(body)) return true;
  if (!/[a-z0-9]/i.test(body)) return true;
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length === 1 && !substantiveQuestion(text)) return true;
  return false;
}

const ACK_RES =
  /^(?:thanks?|thx|ty|got it|understood|nvm|never ?mind|solved|fixed it|works now|that worked|ok|okay|k|cool|nice|perfect|awesome|great|makes sense|yes|yeah|yep|no|nope|nah)\W*$/i;

function ackOnly(text: string): boolean {
  const body = String(text || "").trim();
  if (ACK_RES.test(body)) return true;
  const m = body.match(
    /^(nvm|never ?mind|figured it out|all good|solved|fixed|got it|no worries|ok|okay|thanks?)\b[\s,!.]*/i,
  );
  if (!m) return false;
  const tail = body.slice(m[0].length).trim();
  if (/\?/.test(tail)) return false;
  if (/^(thanks|thank you|got it|figured it out|never ?mind|all good|sorted|done|fixed|solved|works)\W*$/i.test(tail))
    return true;
  return tail.split(/\s+/).filter(Boolean).length <= 1;
}

const SENSITIVE_REQUEST_RES =
  /\?|\b(can|could|would|should|will|please|pls|help|need|want|get|give|approve|override|waive|bypass|extend|charge|verify|review|check|look into|unban|reimburse|refund|process|send|pay|am i|is there|are there|will there|was my|do i)\b/i;
const LEADING_IMPERATIVE_RES =
  /^(?:<@[^>]+>\s*|(?:hey|hi|hello|yo|please|pls)[\s,]+)?[a-z]{3,12}\s+(?:me|my|the|this|that|a|an|for)\b/i;
// A request for a person's decision or personal help. The person noun has to ask
// for something a person would decide or do, so "can someone make a function"
// does not count. "help me with a for loop" never counts on its own.
const PERSON_NOUN = "(?:human|person|helper|organizer|someone|somebody)";
const PERSONAL_ASK_VERB =
  "(?:look\\s+(?:at|into|over)|check|review|approve|decide|override|unlock|unban|restore|reinstate|reset|grant|fix|waive|verify|talk|speak|contact|escalate|help\\s+me\\s+(?:with\\s+)?(?:my|this|that|it)\\b)";
const HUMAN_ASK_RES = new RegExp(
  [
    // "can someone check my ...", "could a helper approve ...", "can a human decide ..."
    `\\b(?:can|could|would|will|should|may)\\s+(?:a|an|the|any|some|one\\s+of\\s+the)?\\s*${PERSON_NOUN}\\s+(?:please\\s+)?${PERSONAL_ASK_VERB}\\b`,
    // "I need an organizer to look at my account", "want someone to approve it"
    `\\b(?:need|needs|want|wants)\\s+(?:a|an|the|any|some)?\\s*${PERSON_NOUN}\\s+to\\s+${PERSONAL_ASK_VERB}\\b`,
    // "human please", "talk to a person", "speak with an organizer"
    `\\b${PERSON_NOUN}\\s+(?:please|pls)\\b`,
    `\\b(?:talk|speak|get\\s+in\\s+touch)\\s+(?:to|with)\\s+(?:a|an|the|some)?\\s*${PERSON_NOUN}\\b`,
  ].join("|"),
  "i",
);
// Programming or technical words. A question about code is never a policy or
// account request, even when it contains "exception" or "error". Bare
// "exception" is not listed: it only counts as technical in context.
const TECHNICAL_CONTEXT_RES =
  /\b(?:python|java|javascript|typescript|rust|golang|php|sql|code|coding|function|functions|method|class|variable|variables|error|errors|stack\s?trace|traceback|try\s*\/\s*(?:except|catch)|catch|caught|throw|throws|thrown|raise|raised|compile|compiler|import|library|api|esp32|arduino|wifi|syntax|module)\b/i;
// Policy context: the request is about rules, eligibility or approvals.
const POLICY_CONTEXT_RES = /\b(?:rules?|policy|policies|allowed|allow|approve|approval|grant|waiver|eligibility)\b/i;
// Words that ask for a rule to be bent. These only count together with policy context.
const POLICY_ACTION_RES =
  /\b(?:exceptions?|overrides?|overriding|waive|waives|waived|waiver|bypass|bypasses|bypassing)\b/i;
// Phrases that are a policy request on their own.
const POLICY_PHRASE_RES = /\b(?:make\s+(?:an?\s+)?exceptions?|manual(?:ly)?\s+(?:override|review|check))\b/i;
// The person's own account, shop, bolts or ticket, with a verb asking someone to act on it.
const ACCOUNT_PERSON_RES = /\b(?:my\s+(?:accounts?|shop|bolts?|tickets?)|(?:log|sign)[ -]?in\s+to\s+my\s+account)\b/i;
// Verbs that ask someone else to act on the account. "check" is left out: checking
// a balance or a read-only view is self-service. It only counts with a problem word.
const ACCOUNT_ACTION_RES =
  /\b(?:approve|unlock|unban|restore|reinstate|recover|reset|grant|fix|change|review|look\s+into|transfer|bypass|override|waive)\b/i;
const ACCOUNT_CHECK_RES = /\bcheck\b/i;
// "can a human look at my account": any request routed to a person about the account.
const ACCOUNT_PERSON_ASK_RES = /\b(?:can|could|would|will)\s+(?:a|an|the|some)?\s*(?:human|person|helper|organizer|someone|somebody)\b/i;
const ACCOUNT_PROBLEM_RES =
  /\b(?:locked|suspended|banned|blocked|frozen|disabled|stuck|flagged|closed|deleted|wrong|missing|broken)\b/i;
const LOCKED_OUT_RES = /\blocked\s+out\b/i;
// "how do I reset my password" is a self-service question the bot should answer.
const SELF_SERVICE_RES = /^\s*(?:how|where|what)\s+(?:do|can|should|would)?\s*(?:i|we|you|to)\b/i;

function explicitHumanRequest(text: string): boolean {
  const body = String(text || "").trim();
  if (!body) return false;
  return HUMAN_ASK_RES.test(body);
}

function technicalContext(text: string): boolean {
  return TECHNICAL_CONTEXT_RES.test(String(text || ""));
}

function accountRequest(text: string): boolean {
  const body = String(text || "").trim();
  if (!body) return false;
  if (LOCKED_OUT_RES.test(body)) return true;
  if (SELF_SERVICE_RES.test(body) && !ACCOUNT_PERSON_ASK_RES.test(body)) return false;
  if (!ACCOUNT_PERSON_RES.test(body)) return false;
  if (ACCOUNT_ACTION_RES.test(body) || ACCOUNT_PERSON_ASK_RES.test(body)) return true;
  return ACCOUNT_CHECK_RES.test(body) && ACCOUNT_PROBLEM_RES.test(body);
}

function policyExceptionRequest(text: string): boolean {
  const body = String(text || "").trim();
  if (!body || technicalContext(body)) return false;
  if (POLICY_PHRASE_RES.test(body)) return true;
  return POLICY_ACTION_RES.test(body) && POLICY_CONTEXT_RES.test(body);
}

function humanReviewRequest(text: string): boolean {
  const body = String(text || "").trim();
  if (!body) return false;
  return explicitHumanRequest(body) || accountRequest(body) || policyExceptionRequest(body);
}

const SELF_HARM_RE =
  /\b(?:self[- ]harm|hurt myself|harm myself|cutting myself|end my life|end it all|kill myself|want to die|suicid(?:e|al)|don['’]?t want to be alive|don['’]?t want to live|no reason to live|wish (?:i were|i was) dead)\b/i;

function selfHarmHit(text: string): boolean {
  return SELF_HARM_RE.test(String(text || ""));
}

function sensitiveHit(text: string, program: Program | null = null): boolean {
  const cats = program && Array.isArray(program.sensitiveCategories) ? program.sensitiveCategories : [];
  const body = String(text || "");
  if (selfHarmHit(body)) return true;
  if (humanReviewRequest(body)) return true;
  if (cats.length === 0) return false;
  const lowered = body.toLowerCase();
  const mentioned = cats.some((cat) => {
    const term = String(cat || "")
      .trim()
      .toLowerCase();
    if (term.length < 3) return false;
    return new RegExp(`\\b${escapeRegex(term)}(?:s|es)?\\b`).test(lowered);
  });
  if (!mentioned) return false;
  if (SENSITIVE_REQUEST_RES.test(body) || LEADING_IMPERATIVE_RES.test(body.trim())) return true;
  return substantiveQuestion(body);
}

const COMMAND_RE = /^(?:!(?:teach|sum|summary|summari[sz]e|mute|stfu)\b|\/(?:[a-z0-9-]+-)?(?:teach|sum)\b)/i;
const MENTION_COMMAND_RE = /^(?:teach|learn|remember|memorize|sum|summary|summari[sz]e)\b/i;

function botCommand(body: string, { botUserId = null, botNames = [] }: BotNameOptions): boolean {
  const text = String(body || "").trim();
  if (COMMAND_RE.test(text)) return true;
  if (!invocationAnalysis(text, { botUserId, botNames }).invocation) return false;
  const bare = text
    .replace(/^<@[^>]+>[\s,:]*/, "")
    .replace(new RegExp(`^(?:${botNamePattern(botNames)})\\w*[\\s,:]*`, "i"), "")
    .trim();
  return COMMAND_RE.test(bare) || MENTION_COMMAND_RE.test(bare);
}

// Self-harm and explicit bot commands are answered before any thread state is read.
function bypassVerdict(body: string, { botUserId = null, botNames = [] }: BotNameOptions): EligibilityDecision | null {
  // Self-harm is checked first: it bypasses mute, takeover and deferral so the
  // person always gets the supportive reply. Still routed as ESCALATE so the
  // ticket path runs; the distinct reason tells the handler to send the crisis reply.
  if (selfHarmHit(body)) {
    return { decision: ESCALATE, reason: SELF_HARM, fileTicket: true };
  }
  if (botCommand(body, { botUserId, botNames })) {
    return { decision: REPLY, reason: "command_bypass" };
  }
  return null;
}

// Verdict for a thread the bot is muted or taken over in; reactivation wins over staying quiet.
function lockedThreadVerdict(
  body: string,
  { botUserId = null, botNames = [] }: BotNameOptions,
  takeover: boolean,
): EligibilityDecision {
  const inv = invocationAnalysis(body, { botUserId, botNames });
  const bare = body
    .replace(/^<@[^>]+>\s*|^\s*(?:hey|hi|hello|yo|please|pls)[\s,]+/i, "")
    .replace(new RegExp(`^(?:${botNamePattern(botNames)})\\w*\\s*`, "i"), "")
    .trim();
  if (
    inv.invocation &&
    (reactivationPhrase(body) || /^(help|help me|come back|wake up|unmute|resume|continue)\s*[.!]*$/i.test(bare))
  ) {
    const reason = takeover ? "takeover_reactivated" : "reactivated";
    return { decision: REPLY, reason, clearMute: true, clearTakeover: true };
  }
  if (takeover) {
    if (inv.invocation) return { decision: REPLY, reason: "takeover_direct_address" };
    return { decision: SILENT, reason: "takeover" };
  }
  if (inv.invocation && substantiveQuestion(body)) {
    return { decision: REPLY, reason: "muted_direct_address" };
  }
  return { decision: SILENT, reason: "muted" };
}

// Deferrals to a human: a takeover cue in a reply thread, a muted posture, or a message aimed at a person.
function deferralVerdict(
  body: string,
  inv: { invocation: boolean },
  {
    botUserId = null,
    botNames = [],
    isTopLevel,
    isDM,
    posture,
  }: BotNameOptions & { isTopLevel: boolean; isDM: boolean; posture: string },
): EligibilityDecision | null {
  if (!isTopLevel && takeoverCue(body, botNames)) {
    return { decision: HUMAN_DEFER, reason: "human_takeover", markTakeover: true };
  }
  if (posture === "muted") return { decision: SILENT, reason: "posture_muted" };
  if (!isDM && !inv.invocation && humanDirected(body, { botUserId })) {
    return { decision: HUMAN_DEFER, reason: "human_directed" };
  }
  if (!isDM && !inv.invocation && explicitHumanRequest(body)) {
    return { decision: HUMAN_DEFER, reason: "human_review_request" };
  }
  return null;
}

// Silent verdicts for messages that need no reply: referential mentions, greetings, acks and follow-ups on an open ticket.
function quietVerdict(
  body: string,
  inv: { referential: boolean; invocation: boolean },
  t: ThreadState,
  { botUserId = null, isTopLevel }: { botUserId?: string | null; isTopLevel: boolean },
): EligibilityDecision | null {
  const freshInterrogative =
    /\?/.test(body) ||
    /^\s*(?:how|what|when|where|why|which|who|can|could|would|should|is|are|do|does|did|will)\b/i.test(body) ||
    /\b(?:how|what|when|where|why|which)\b/i.test(body);
  if (inv.referential && !freshInterrogative) {
    return { decision: SILENT, reason: "referential_mention" };
  }

  const complimentOnly =
    /\b(?:goated|the goat|love (?:you|u)|best bot)\b/i.test(body) &&
    !/\?/.test(body) &&
    body.split(/\s+/).filter(Boolean).length <= 6;
  if (isTopLevel && !inv.invocation && greetingOrNoise(body)) {
    return { decision: SILENT, reason: "greeting", noTicket: true };
  }
  if (isTopLevel && complimentOnly) {
    return { decision: SILENT, reason: "greeting", noTicket: true };
  }

  if (!isTopLevel && t.orrySpoke && !inv.invocation && ackOnly(body)) {
    return { decision: SILENT, reason: "acknowledged" };
  }

  if (
    !isTopLevel &&
    t.ticketOpen &&
    !inv.invocation &&
    (!substantiveQuestion(body) ||
      /\b(anyone|everyone|somebody|someone|anybody|you guys|y[’']all)\b/i.test(body) ||
      humanDirected(body, { botUserId }))
  ) {
    return { decision: SILENT, reason: "already_escalated", touchTicket: true };
  }
  return null;
}

function shouldOrryRespond({
  text,
  userId = null,
  botUserId = null,
  botNames = [],
  isHelpChannel = false,
  isTopLevel = true,
  isDM = false,
  posture = "active",
  program = null,
  thread = null,
  actorIsHelper = false,
}: EligibilityOptions = {}): EligibilityDecision {
  const t = thread || {};
  const body = String(text || "");

  const bypass = bypassVerdict(body, { botUserId, botNames });
  if (bypass) return bypass;

  if (t.muted) return lockedThreadVerdict(body, { botUserId, botNames }, false);
  if (t.takeover) return lockedThreadVerdict(body, { botUserId, botNames }, true);

  const inv = invocationAnalysis(body, { botUserId, botNames });
  const deferred = deferralVerdict(body, inv, { botUserId, botNames, isTopLevel, isDM, posture });
  if (deferred) return deferred;

  if (sensitiveHit(body, program)) {
    return { decision: ESCALATE, reason: "sensitive_escalation", fileTicket: true };
  }

  if (isDM) return { decision: REPLY, reason: "dm" };

  const quiet = quietVerdict(body, inv, t, { botUserId, isTopLevel });
  if (quiet) return quiet;

  if (isHelpChannel) {
    if (isTopLevel) return { decision: REPLY, reason: "help_channel_ask" };
    return { decision: REPLY, reason: "help_thread_followup" };
  }

  if (inv.invocation) return { decision: REPLY, reason: "addressed" };
  if (!isTopLevel && t.orrySpoke) return { decision: REPLY, reason: "thread_followup" };
  if (isTopLevel) return { decision: REPLY, reason: "ambient_candidate" };
  return { decision: SILENT, reason: "main_thread_not_joined" };
}

export = {
  shouldOrryRespond,
  botCommand,
  invocationAnalysis,
  humanDirected,
  takeoverCue,
  reactivationPhrase,
  greetingOrNoise,
  substantiveQuestion,
  ackOnly,
  sensitiveHit,
  selfHarmHit,
  humanReviewRequest,
  policyExceptionRequest,
  accountRequest,
  technicalContext,
  otherMentions,
  directMention,
  botNamePattern,
  escapeRegex,
  stripBotMention,
  REPLY,
  SILENT,
  ESCALATE,
  HUMAN_DEFER,
  SELF_HARM,
};
