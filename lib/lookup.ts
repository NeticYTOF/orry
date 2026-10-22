const knowledge = require("./knowledge");
const answer = require("./answer");
const cache = require("./cache");
const program = require("./program");
const programs = require("./programs");
const link = require("./link");
const db = require("./db");
const log = require("./log");
const firecrawl = require("./firecrawl");
const validator = require("./validator");
const grounding = require("./grounding");
import type { Program, ProgramSource } from "./types";

type ProgramLike = Partial<Program> & { id?: string };
type SourceLike = Partial<ProgramSource> & {
  siteUrl?: string;
  hidden?: boolean;
  dynamic?: boolean;
  content?: unknown;
  paths?: string[];
};
interface AnswerResult {
  source?: string | null;
  answer?: string;
  unclear?: boolean;
  silent?: boolean;
  personality?: string;
  direct?: boolean;
  groundingVerdict?: unknown;
  evidence?: unknown[];
  fixtureClaims?: unknown[];
  unresolved?: string[];
  citationEvidence?: unknown[];
  passageCitations?: unknown[];
  groundedAnswer?: string;
  uncertaintyReply?: string;
  suggestedSource?: { name: string; url?: string | null } | null;
}
interface AnswerOptions {
  onText?: ((text: string) => void) | null;
  inHelpChannel?: boolean;
  program?: ProgramLike | string | null;
  channel?: string | null;
  allowWebSearch?: boolean;
  isPing?: boolean;
  skipCache?: boolean;
  previousQuestion?: string | null;
  answerMode?: "program" | "general";
}
interface WebResult {
  title?: string;
  url?: string;
  markdown?: string;
}

type AnswerMode = "docs-only" | "help-only" | "always";
const DOCS_ONLY: AnswerMode = "docs-only";

function idOf(program: ProgramLike | string | null | undefined) {
  if (!program) return null;
  return typeof program === "string" ? program : program.id || null;
}

function cacheScope(program: ProgramLike | string | null | undefined) {
  const id = idOf(program);
  return id;
}

function programSources(record: ProgramLike | string | null | undefined): SourceLike[] {
  const resolved: ProgramLike | null =
    (typeof record === "string" ? (programs.get(record) as ProgramLike) : record) || null;
  const shared = resolved && resolved.sharedSources === false ? [] : programs.shared().sources || [];
  return [...(resolved?.sources || []), ...shared];
}

function likelySource(passages: Array<{ source: string; kind?: string }>, prog: ProgramLike | string | null) {
  for (const passage of passages) {
    if (passage.kind !== "source") continue;
    const source = programSources(prog).find(
      (candidate) => candidate.name?.toLowerCase() === passage.source.toLowerCase() && !candidate.hidden,
    );
    if (!source?.name) continue;
    const possibleUrl = source.siteUrl || knowledge.getSourceUrl(source.name);
    let url: string | null = null;
    try {
      const parsed = possibleUrl ? new URL(possibleUrl) : null;
      if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) url = parsed.href;
    } catch (_error: unknown) {
      url = null;
    }
    return { name: source.name, url };
  }
  return null;
}

function suggestedSourceForQuestion(question: string, prog: ProgramLike | string | null = null) {
  const { passages } = knowledge.getEvidenceContext(retrievalQuery(question, "", prog), idOf(prog));
  return likelySource(passages, prog);
}

function cacheHit(question: string, contextPrompt: string, programId: string | null = null, skipCache = false) {
  if (contextPrompt || skipCache) return null;
  const hit = cache.get(question, programId);
  if (!hit) return null;
  const citedSource = programSources(programId).find(
    (source) =>
      source?.dynamic === true &&
      (source.name?.trim().toLowerCase() === hit.source?.trim().toLowerCase() ||
        knowledge.sourceContainsCitation(source, hit.source || "")),
  );
  if (citedSource && !knowledge.sourceEligibility(citedSource).exactClaimsAllowed) {
    log.debug("grounding", `bypassing cache entry from stale dynamic source "${citedSource.name}"`);
    return null;
  }
  // shortcut: cached doc answers lack passage evidence, re-enable when the cache stores citation IDs.
  if (hit.source) return null;
  log.debug("respond", "cache hit");
  db.recordMetric("cache_hit");
  return hit;
}

function dateFallback(question: string, contextPrompt: string, prog: ProgramLike | string | null = null) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const programId = idOf(record || prog);
  const milestones = record
    ? record.sharedSources === false
      ? record.milestones || []
      : record.milestones || programs.shared().milestones
    : programs.shared().milestones;

  const direct = program.directAnswer(question, new Date(), milestones, record);
  return direct;
}

async function repoValidatorAnswer(question: string) {
  const isCheckQuery = /\b(?:check|inspect|validate|review|audit|ready for submission|submission check)\b/i.test(
    question,
  );
  const parsed = validator.parseGithubUrl(question);
  if (parsed && (isCheckQuery || /^\s*https?:\/\/github\.com\/[^\s]+\s*$/i.test(question))) {
    const report = await validator.validateRepository(parsed.url);
    if (report && report.ok) {
      db.recordMetric("answer_validator");
      return {
        source: "Repo Validator",
        direct: true,
        answer: validator.formatValidationReport(report),
      };
    }
  }
  return null;
}

async function runCodeStages(question: string) {
  const validated = await repoValidatorAnswer(question);
  if (validated) return validated;

  return null;
}

const AUTHORITATIVE_ONLY_RES = [
  /\b(?:first|second|third|1st|2nd|3rd)\s+pass\b/i,
  /\bfraud\s*review\b/i,
  /\breview\w*\s+(?:queue|status|state)\b/i,
  /\breview\w*\b[^.!?\n]{0,40}\b(?:how\s+long|eta|timing|take|takes|taking|taken|duration|when|available|availability|waiting|wait|pending|stuck|slow)\b/i,
  /\b(?:how\s+long|eta|when)\b[^.!?\n]{0,25}\breview\w*\b/i,
  /\bwhy\b[^.!?\n]{0,40}\b(?:review\w*|approved|passed|waiting|pending|stuck)\b/i,
  /\bwill\s+(?:my|this|it|the\s+project)\b[^.!?\n]{0,25}\b(?:pass|fail|get\s+(?:approved|rejected))\b/i,
  /\bdeflat\w*\b/i,
  /\bcount(?:s|ed|ing)?\s+(?:as|toward|towards|for|into)\b/i,
  /\b(?:does|do|is|are|would|will)\b[^.!?\n]{0,40}\bcount\b/i,
  /\b(?:research|learning|tutorial)\s+time\b/i,
  /\buncommitted\b[^.!?\n]{0,20}\bsession/i,
  /\bwhat\s+evidence\b/i,
  /\bhand[- ]?drawn\b|\bhandwritten\b/i,
  /\bai\s+(?:limit|percentage|cap|allowance|policy)\b/i,
  /\bhow\s+much\s+ai\b/i,
  /\bfraud\b/i,
  /\b(?:banned?|appeal\w*|penalt\w*|violat\w*)\b/i,
  /\bpayout\w*\b[^.!?\n]{0,25}\b(?:when|how\s+much|exact|amount|timing)\b/i,
  /\b(?:when|how\s+long)\b[^.!?\n]{0,25}\bpayout\w*\b/i,
  /\bshipping\s+(?:time|eta|when|status)\b/i,
  /\bwhen\b[^.!?\n]{0,20}\b(?:ship|shipped|arrive|arrives)\b/i,
  /\bcustoms\b/i,
  /\bgrant\w*\b[^.!?\n]{0,25}\b(?:status|when|amount)\b/i,
  /\border\s+status\b|\btracking\s+number\b/i,
  /\b(?:policy|rule|rules|eligible|eligibility|allowed|prohibited|forbidden|tax|expense|locally)\b/i,
];

function isAuthoritativeOnlyTopic(question: string, result: AnswerResult | null) {
  if (result?.direct) return false;
  const text = String(question || "");
  return AUTHORITATIVE_ONLY_RES.some((re) => re.test(text));
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const NUMBER_WORD_ALTERNATION = Object.keys(NUMBER_WORDS).join("|");
const NUMERIC_UNIT = "(?:percent|px|pixels?|hours?|hrs?|days?|weeks?|months?|dollars?|points?|bolts?|xp)";
const NUMERIC_CLAIM_RE = new RegExp(
  [
    "\\$\\s?\\d+(?:,\\d{3})*(?:\\.\\d+)?",
    "\\b\\d[\\d,.]*\\s?%",
    `\\b\\d[\\d,.]*[\\s-]?${NUMERIC_UNIT}\\b`,
    `\\b(?:${NUMBER_WORD_ALTERNATION})[\\s-]?(?:%|${NUMERIC_UNIT}\\b)`,
  ].join("|"),
  "gi",
);
const WORD_NUMBER_BEFORE_UNIT = new RegExp(`\\b(${NUMBER_WORD_ALTERNATION})(?=[\\s-]?(?:%|${NUMERIC_UNIT}\\b))`, "gi");

// Brings a claim and a passage to one form: no currency symbols or thousands separators, no trailing
// punctuation after a number, number words from one to twenty written as digits before a unit, and
// single spacing. "$1,000." and "1000 dollars" then compare equal, and "five days" equals "5 days".
function normalizeNumericText(text: string) {
  return String(text || "")
    .toLowerCase()
    .replace(/[$€£¥]/g, "")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/(\d)\.(?!\d)/g, "$1")
    .replace(/(\d)-(?=[a-z%])/g, "$1 ")
    .replace(WORD_NUMBER_BEFORE_UNIT, (word: string) => String(NUMBER_WORDS[word.toLowerCase()]))
    .replace(/\s+/g, " ")
    .replace(/\s+%/g, "%")
    .replace(/[.,;:!?]+$/, "")
    .trim();
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasNumericClaim(text: string) {
  return (String(text || "").match(NUMERIC_CLAIM_RE) || []).length > 0;
}

// A number in the answer must appear, as a whole number, in the text it is checked against. The
// caller decides that text: the cited passages when there are any, never the user's question.
function numericClaimsGrounded(answerText: string, corpusText: string) {
  if (!corpusText) return true;
  const claims = String(answerText || "").match(NUMERIC_CLAIM_RE) || [];
  if (claims.length === 0) return true;
  const corpusNorm = normalizeNumericText(corpusText);
  return claims.every((claim) => {
    const claimNorm = normalizeNumericText(claim);
    if (!claimNorm) return true;
    return new RegExp(`(?<![\\d.])${escapeRegExp(claimNorm)}(?!\\d)`).test(corpusNorm);
  });
}

function evidencePrompt(passages: Array<{ id: string; source: string; heading?: string; text: string }>) {
  return passages
    .map(
      ({ source, heading, text }, index) => `### ${source} [E${index + 1}]${heading ? ` — ${heading}` : ""}\n${text}`,
    )
    .join("\n\n");
}

async function evidenceForQuestion(
  query: string,
  question: string,
  programId: string | null,
  prog: ProgramLike | string | null,
  channel: string | null,
  semanticFallback = true,
) {
  const initial = knowledge.getEvidenceContext(query, programId, {
    semanticFallback: false,
    matchQuestion: question,
  });
  if (!semanticFallback || !initial.weakMatch) return initial;

  const queries = await answer.expandSearchQueries(question, prog, channel);
  if (!queries.length) return knowledge.getEvidenceContext(query, programId, { semanticFallback: true });
  return knowledge.getEvidenceContext(query, programId, {
    semanticFallback: true,
    additionalQueries: queries,
    matchQuestion: question,
  });
}

function canonicalFaqQuestion(question: string, prog: ProgramLike | string | null) {
  const resolved = typeof prog === "string" ? (programs.get(prog) as ProgramLike) : prog;
  const programName = resolved?.name?.trim();
  if (!programName) return question;

  const normalized = question
    .trim()
    .replace(/^(?:no\s+)?(?:i\s+)?(?:just\s+)?meant\s+/i, "")
    .replace(/\bthsi\b/gi, "this")
    .replace(/[?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (/^what\s+(?:is\s+)?(?:this\s+)?(?:ysws|program|project)(?:\s+is)?$/.test(normalized)) {
    return `What is ${programName}?`;
  }
  return question;
}

function exactFaqAnswer(question: string, passages: Array<{ source: string; text: string }>): AnswerResult | null {
  const ignoredWords = new Set(["a", "an", "the", "this", "that"]);
  const normalize = (value: string) =>
    value
      .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/gi, " ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((word) => word && !ignoredWords.has(word))
      .join(" ")
      .trim();
  const expected = normalize(question);
  if (!expected) return null;

  for (const [index, passage] of passages.entries()) {
    if (!/faq|frequently asked/i.test(`${passage.source}\n${passage.text.slice(0, 100)}`)) continue;
    for (const match of passage.text.matchAll(/^\s*\*\*([^*\n]+)\*\*\s+(.+)$/gm)) {
      if (normalize(match[1]) === expected && match[2].trim()) {
        return { source: passage.source, answer: `${match[2].trim()} [E${index + 1}]` };
      }
    }
  }
  return null;
}

function separateExplicitUncertainty(answer: string, question: string) {
  const parts = question.split(/\s+(?:and|also|as well as)\s+/i).map((part) => part.trim());
  if (parts.length < 2) return { answer, unresolved: [] as string[] };

  const marker =
    /\s+(?:(?:and|also|as well as)\s+)?(?:honestly\s+)?(?:as for|no clue|not sure|don't know|do not know|can't see|cannot see|can't confirm|cannot confirm|couldn't confirm|can't tell|cannot tell|can't determine|cannot determine|unable to confirm)\b/i;
  const match = marker.exec(answer);
  if (!match || !answer.slice(0, match.index).trim()) return { answer, unresolved: [] as string[] };

  const uncertainty = answer.slice(match.index);
  if (
    !/\b(?:no clue|not sure|don't know|do not know|can't see|cannot see|can't confirm|cannot confirm|couldn't confirm|can't tell|cannot tell|can't determine|cannot determine|unable to confirm|not something (?:i|we) can see)\b/i.test(
      uncertainty,
    )
  )
    return { answer, unresolved: [] as string[] };
  const uncertaintyTokens = new Set(uncertainty.toLowerCase().match(/[a-z0-9]+/g) || []);
  const generic = new Set([
    "what",
    "when",
    "where",
    "how",
    "who",
    "why",
    "is",
    "are",
    "was",
    "were",
    "do",
    "does",
    "did",
    "my",
    "your",
    "the",
    "a",
    "an",
    "and",
    "or",
    "project",
    "exact",
    "date",
    "status",
  ]);
  const unresolved = parts
    .slice(1)
    .filter((part) =>
      (part.toLowerCase().match(/[a-z0-9]+/g) || []).some(
        (token) => token.length > 2 && !generic.has(token) && uncertaintyTokens.has(token),
      ),
    );
  if (!unresolved.length) return { answer, unresolved: [] as string[] };

  const factualAnswer = answer
    .slice(0, match.index)
    .trim()
    .replace(/(?:,|and|also|as well as|—|:)+\s*$/i, "")
    .trim();
  return {
    answer: factualAnswer,
    unresolved: unresolved.map((part) => `this part: “${part.replace(/[?.!]+$/g, "")}”`),
  };
}

function claimKey(text: unknown) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Sentence-level grounding. Each factual sentence is kept only if the verifier supports it from its
// cited passages (or, when the verifier is unavailable, if its citations resolve to eligible passages).
// Unsupported sentences are dropped and named in an UNRESOLVED note. The whole answer is refused only
// when no factual sentence survives.
async function applyPassageCitations(
  result: AnswerResult | null,
  passages: Array<{
    id: string;
    source: string;
    heading?: string;
    text: string;
    programId?: string | null;
    kind?: string;
  }>,
  prog: ProgramLike | string | null,
  question = "",
  contextQuestion: string | null = null,
) {
  if (!result?.source || result.source.trim().toUpperCase() === "NONE") return result;
  const programId = idOf(prog);
  if (!programId) return null;
  const sources = programSources(prog);
  const eligible = new Map<string, (typeof passages)[number]>();
  const aliases = new Map<string, string>();
  for (const [index, passage] of passages.entries()) {
    if (!passage.id || passage.programId !== programId) continue;
    const configured = sources.find((source) => source.name?.toLowerCase() === passage.source.toLowerCase());
    if (passage.kind === "source" && !configured) continue;
    if (configured?.hidden) continue;
    if (configured) {
      const freshness = knowledge.sourceEligibility(configured);
      if (!(freshness.exactClaimsAllowed || (freshness.authority !== "dynamic" && passage.kind === "source"))) continue;
    } else if (passage.kind !== "generated") {
      continue;
    }
    eligible.set(passage.id, passage);
    aliases.set(`E${index + 1}`, passage.id);
  }
  const separated = separateExplicitUncertainty(String(result.answer || ""), question);
  if (!result.unresolved?.length && separated.unresolved.length) result.unresolved = separated.unresolved;

  // Hedges are kept as written. Every other sentence is a factual claim to verify, and a claim whose
  // citation cannot be resolved is dropped without being sent to the verifier.
  type Piece = { hedge: true; text: string } | { hedge: false; index: number };
  const pieces: Piece[] = [];
  const factual: Array<{ claim: string; evidenceIds: string[]; invalid: boolean }> = [];
  for (const sentence of grounding.splitAnswerSentences(separated.answer)) {
    const claim = sentence
      .replace(/\[E\d+\]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/\s+([.,!?;:])/g, "$1");
    if (!claim) continue;
    if (grounding.isHedgeSentence(claim) && !hasNumericClaim(claim)) {
      pieces.push({ hedge: true, text: claim });
      continue;
    }
    const aliasTokens = [...sentence.matchAll(/\[(E\d+)\]/g)].map((match) => match[1]);
    const evidenceIds = [
      ...new Set(aliasTokens.flatMap((alias) => (aliases.has(alias) ? [aliases.get(alias)!] : []))),
    ];
    const invalid =
      aliasTokens.some((alias) => !aliases.has(alias)) || /\[[^\]\n]*\bE\d/i.test(sentence.replace(/\[E\d+\]/g, ""));
    pieces.push({ hedge: false, index: factual.length });
    factual.push({ claim, evidenceIds, invalid });
  }

  const verifiable = factual.flatMap((item, index) => (item.invalid ? [] : [{ ...item, index }]));
  if (!verifiable.length) return null;
  const verificationEvidence = [...eligible.values()].map((passage) => ({ ...passage, programId }));
  const expectedClaims = verifiable.map(({ claim, evidenceIds }) => ({ claim, evidenceIds }));
  const needsCoverage = Boolean(question || result.unresolved?.length);
  const coverageRequest = { question, contextQuestion, unresolved: result.unresolved || [] };
  let verdict: unknown = null;
  try {
    verdict = await answer.verifyGrounding(expectedClaims, verificationEvidence, prog, null, {
      ...(needsCoverage ? { requestCoverage: coverageRequest } : {}),
    });
  } catch (error: unknown) {
    log.debug("grounding", `claim verifier failed: ${error instanceof Error ? error.message : String(error)}`);
    verdict = null;
  }
  const verifierAvailable = verdict !== null && verdict !== undefined;
  const verified = verifierAvailable ? grounding.parseGroundingVerdict(verdict) : null;
  // A verdict that is present but unusable cannot say which sentence is supported, so nothing is kept.
  if (
    verified &&
    (!verified.ok ||
      verified.claims.length !== expectedClaims.length ||
      verified.claims.some((claim, index) => claimKey(claim.claim) !== claimKey(expectedClaims[index].claim)))
  )
    return null;

  const evidenceText = (ids: string[]) => ids.map((id) => eligible.get(id)?.text || "").join("\n");
  const decisions = new Map<number, { ok: boolean; ids: string[] }>();
  verifiable.forEach((item, position) => {
    const expected = expectedClaims[position];
    let ids: string[];
    let ok: boolean;
    if (verified) {
      const claim = verified.claims[position];
      ids = claim.evidenceIds;
      ok =
        claim.supported &&
        grounding.validatePassageClaims({
          verdict: { verdict: "supported", claims: [claim] },
          expectedClaims: [expected],
          evidence: verificationEvidence,
          programId,
        }).supported;
    } else {
      // The verifier threw or timed out: accept the sentence when its citations resolve to eligible passages.
      ids = expected.evidenceIds;
      ok =
        ids.length > 0 &&
        grounding.validatePassageCitations({ citations: ids, evidence: verificationEvidence, programId }).supported;
    }
    if (ok && !numericClaimsGrounded(item.claim, evidenceText(ids))) ok = false;
    decisions.set(item.index, { ok, ids });
  });

  const kept: string[] = [];
  const dropped: string[] = [];
  const usedIds = new Set<string>();
  let keptFactual = 0;
  for (const piece of pieces) {
    if (piece.hedge === true) {
      kept.push(piece.text);
      continue;
    }
    const decision = decisions.get(piece.index);
    if (decision?.ok) {
      keptFactual += 1;
      kept.push(factual[piece.index].claim);
      for (const id of decision.ids) usedIds.add(id);
    } else {
      dropped.push(factual[piece.index].claim);
    }
  }
  if (!keptFactual || !usedIds.size) return null;
  if ([...usedIds].some((id) => !eligible.has(id))) return null;

  const disclosed = [
    ...(result.unresolved || []),
    ...dropped.map((claim) => `this part: “${claim.replace(/[.!?]+$/, "")}”`),
  ];
  // Coverage: every part of the question must be answered or disclosed. The verifier was not
  // reachable, so there is nothing more to check and the verified sentences stand.
  if (needsCoverage && verified) {
    let coverage = verified.coverage === true;
    if (dropped.length) {
      const keptExpected = verifiable.flatMap((item, position) =>
        decisions.get(item.index)?.ok ? [expectedClaims[position]] : [],
      );
      let coverageVerdict: unknown = null;
      try {
        coverageVerdict = await answer.verifyGrounding(keptExpected, verificationEvidence, prog, null, {
          requestCoverage: { ...coverageRequest, unresolved: disclosed },
        });
      } catch (error: unknown) {
        log.debug("grounding", `coverage verifier failed: ${error instanceof Error ? error.message : String(error)}`);
        coverageVerdict = null;
      }
      if (coverageVerdict === null || coverageVerdict === undefined) {
        coverage = true;
      } else {
        const parsedCoverage = grounding.parseGroundingVerdict(coverageVerdict);
        coverage = Boolean(
          parsedCoverage.ok &&
          parsedCoverage.coverage === true &&
          parsedCoverage.claims.length === keptExpected.length &&
          parsedCoverage.claims.every(
            (claim, index) => claim.supported && claimKey(claim.claim) === claimKey(keptExpected[index].claim),
          ) &&
          grounding.validatePassageClaims({
            verdict: { ...parsedCoverage, verdict: "supported" },
            expectedClaims: keptExpected,
            evidence: verificationEvidence,
            programId,
          }).supported,
        );
      }
    }
    if (!coverage) {
      log.debug("grounding", "answer did not cover the current question and unresolved parts");
      return null;
    }
  }

  const validity = grounding.validatePassageCitations({
    citations: [...usedIds],
    evidence: verificationEvidence,
    programId,
  });
  if (!validity.supported) return null;
  const cited = new Map([...usedIds].map((id) => [id, eligible.get(id)!]));
  const groundedText = kept.join(" ").trim();
  if (!groundedText) return null;
  result.groundedAnswer = groundedText;
  result.answer = groundedText;
  result.source = cited.values().next().value?.source || result.source;
  result.citationEvidence = [...cited.values()];
  result.passageCitations = [...cited.keys()];
  if (disclosed.length) {
    result.answer += `\n\nI couldn't confirm ${disclosed.join("; ")} in the docs, so I can't answer those parts.`;
  }
  if (result.personality) result.answer += `\n\n${result.personality}`;
  return result;
}

async function citeTimelineFallback(
  result: AnswerResult | null,
  passages: Parameters<typeof applyPassageCitations>[1],
  prog: ProgramLike | string | null,
  question = "",
  contextQuestion: string | null = null,
) {
  if (!result?.source || result.source !== "Program timeline") return result;
  const index = passages.findIndex((passage) => passage.source === "Program timeline");
  if (index < 0) return null;
  result.answer = `${result.answer || ""} [E${index + 1}]`;
  return await applyPassageCitations(result, passages, prog, question, contextQuestion);
}

function exactClaimAllowed(result: AnswerResult | null, prog: ProgramLike | string | null, question = "", corpus = "") {
  if (!result) return false;
  prog = typeof prog === "string" ? programs.get(prog) : prog;
  let structuredSupport = false;
  if (result.passageCitations || result.citationEvidence) {
    const checked = grounding.validatePassageCitations({
      citations: result.passageCitations,
      evidence: result.citationEvidence,
      programId: idOf(prog) || "",
    });
    if (!checked.supported) return false;
    structuredSupport = true;
  }
  if (result.groundingVerdict || result.evidence) {
    const programId = idOf(prog);
    if (!programId) return false;
    const checked = grounding.validateClaimSupport({
      verdict: result.groundingVerdict,
      evidence: result.evidence,
      programId,
      fixtureClaims: result.fixtureClaims || [],
    });
    if (!checked.supported) return false;
    structuredSupport = true;
  }

  const sources = programSources(prog);
  const reportedSource = result.source ? result.source.trim().toLowerCase() : "";
  const source = sources.find((candidate) => {
    if (!candidate?.name || !reportedSource) return false;
    if (candidate.name.toLowerCase() === reportedSource) return true;
    return knowledge.sourceContainsCitation(candidate, reportedSource);
  });
  if (!source) return !isAuthoritativeOnlyTopic(question, result);
  const freshness = knowledge.sourceEligibility(source);
  if (!(freshness.exactClaimsAllowed || (structuredSupport && freshness.authority !== "dynamic"))) return false;
  // Check only the factual sentences (not the UNRESOLVED note or personality line), against the cited
  // passages when there are any. The user's question is never a source of a grounded number.
  const cited = Array.isArray(result.citationEvidence) ? (result.citationEvidence as Array<{ text?: unknown }>) : [];
  const citedText = cited.length ? cited.map((passage) => String(passage?.text || "")).join("\n") : corpus;
  return numericClaimsGrounded(result.groundedAnswer ?? result.answer ?? "", citedText);
}

function applyGroundingBoundary(
  result: AnswerResult | null,
  prog: ProgramLike | string | null,
  question = "",
  corpus = "",
) {
  if (!result) return result;
  if (result.unclear) return result;
  const allowed = exactClaimAllowed(result, prog, question, corpus);
  if (!allowed) {
    log.warn(
      "grounding",
      `rejected program=${idOf(prog) || "none"} source=${result.source || "NONE"} answer_chars=${result.answer?.length || 0} authoritative_only=${isAuthoritativeOnlyTopic(question, result)}`,
    );
    return null;
  }
  return result;
}

// The bot's own name is not something people are asking about, so drop it from the
// search query when real words remain. A bare "what is orry?" keeps its name.
function withoutBotName(text: string) {
  const brand = require("./brand");
  const retrieve = require("./retrieve");
  const names = [...new Set([brand.slug(), brand.name().toLowerCase()])].map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const stripped = text
    .replace(new RegExp(`\\b(?:${names.join("|")})\\b[,:!?]*`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
  return retrieve.tokenize(stripped).length > 0 ? stripped : text;
}

function retrievalQuery(question: string, contextPrompt = "", prog: ProgramLike | string | null = null) {
  let q = withoutBotName((question || "").trim());
  if (!contextPrompt || !contextPrompt.trim()) return q;

  const resolved = typeof prog === "string" ? (programs.get(prog) as ProgramLike) : prog;
  const rawProgName = resolved?.name || resolved?.id || "";
  const progName = /sandbox|test|staging/i.test(rawProgName) ? "" : rawProgName;

  const isFollowUp =
    /\b(it|that|this|they|them|how|what|why|steps|more|work|works|start|join|rules)\b/i.test(q) &&
    q.split(/\s+/).length <= 8;

  if (isFollowUp) {
    if (progName && !new RegExp(`\\b${progName}\\b`, "i").test(q)) {
      q = `${q} ${progName}`;
    }
    const userMatches = [...contextPrompt.matchAll(/User:\s*([^\n]+)/gi)];
    if (userMatches.length > 0) {
      const lastUserQ = userMatches[userMatches.length - 1][1].trim();
      if (lastUserQ && lastUserQ.toLowerCase() !== (question || "").trim().toLowerCase()) {
        q = `${q} ${lastUserQ}`;
      }
    }
  }

  return q;
}

async function lookupAnswer(
  question: string,
  contextPrompt = "",
  prog: ProgramLike | string | null = null,
  channel: string | null = null,
  { isPing = false, skipCache = false }: Pick<AnswerOptions, "isPing" | "skipCache"> = {},
) {
  question = canonicalFaqQuestion(question, prog);
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, cacheScope(prog), skipCache);
  if (hit) return hit;

  const staged = await runCodeStages(question);
  if (staged) return staged;

  const query = retrievalQuery(question, contextPrompt, prog);
  const { passages } = await evidenceForQuestion(query, question, programId, prog, channel);
  const corpus = evidencePrompt(passages);
  let result = exactFaqAnswer(question, passages);
  if (!result) result = await answer.getGroundedAnswer(question, corpus, contextPrompt, prog, channel, { isPing });
  if (result) {
    result = await applyPassageCitations(result, passages, prog, question);
    result = applyGroundingBoundary(result, prog, question, corpus);
  }
  if (result) {
    if (!contextPrompt && !result.citationEvidence) cache.put(question, result, cacheScope(prog));
    return result;
  }
  return citeTimelineFallback(dateFallback(question, contextPrompt, prog), passages, prog, question);
}

async function answerOrChat(
  question: string,
  contextPrompt = "",
  {
    onText = null,
    inHelpChannel = false,
    program: prog = null,
    channel = null,
    allowWebSearch = false,
    isPing = false,
    skipCache = false,
    previousQuestion = null,
    answerMode = "program",
  }: AnswerOptions = {},
) {
  question = canonicalFaqQuestion(question, prog);
  const programId = idOf(prog);
  const hit = previousQuestion ? null : cacheHit(question, contextPrompt, cacheScope(prog), skipCache);
  if (hit) return hit;

  const staged = await runCodeStages(question);
  if (staged) return staged;

  const query = previousQuestion
    ? retrievalQuery(question, `User: ${previousQuestion}`, prog)
    : retrievalQuery(question, contextPrompt, prog);
  const { passages } = await evidenceForQuestion(query, question, programId, prog, channel, answerMode !== "general");
  const corpus = evidencePrompt(passages);
  let result = exactFaqAnswer(question, passages);
  if (!result) {
    result =
      onText && passages.length === 0
        ? await answer.getAnswerOrChatStream(question, corpus, contextPrompt, {
            onText,
            inHelpChannel,
            program: prog,
            channel,
            isPing,
            answerMode,
          })
        : await answer.getAnswerOrChat(question, corpus, contextPrompt, inHelpChannel, prog, channel, {
            isPing,
            answerMode,
          });
  }

  if (!result?.source && !result?.unclear && result?.answer?.trim().toUpperCase() !== answer.UNCLEAR_MARKER) {
    const direct = dateFallback(question, contextPrompt, prog);
    if (direct) return await citeTimelineFallback(direct, passages, prog, question);

    result =
      (await webFallback({
        question,
        contextPrompt,
        corpus,
        passages,
        prog,
        channel,
        isPing,
        inHelpChannel,
        allowWebSearch,
      })) || result;
  }

  result = await applyPassageCitations(result, passages, prog, question, previousQuestion);
  result = applyGroundingBoundary(result, prog, question, corpus);
  if (!result && answerMode === "general" && isAuthoritativeOnlyTopic(question, null)) {
    result = { source: null, answer: "", unclear: true };
  }
  if (result?.unclear && !result.silent) result.suggestedSource = likelySource(passages, prog);
  if (result?.source && !contextPrompt && !previousQuestion && !result.citationEvidence)
    cache.put(question, result, cacheScope(prog));
  return result;
}

async function webFallback({
  question,
  contextPrompt,
  corpus,
  passages,
  prog,
  channel,
  isPing,
  inHelpChannel,
  allowWebSearch,
}: {
  question: string;
  contextPrompt: string;
  corpus: string;
  passages: Array<{
    id: string;
    source: string;
    heading?: string;
    text: string;
    programId?: string | null;
    kind?: string;
  }>;
  prog: ProgramLike | string | null;
  channel: string | null;
  isPing: boolean;
  inHelpChannel: boolean;
  allowWebSearch: boolean;
}) {
  if (!allowWebSearch) return null;
  const webResults = await firecrawl.searchWeb(question).catch(() => null);
  if (!webResults || webResults.length === 0) return null;
  const webSnippet = webResults.map((r: WebResult) => `Title: ${r.title}\nURL: ${r.url}\n${r.markdown}`).join("\n\n");
  const webContextPrompt = `${contextPrompt}\n\n=== WEB RESEARCH ===\n${webSnippet}`;
  const result = await answer
    .getGroundedAnswer(question, corpus, webContextPrompt, prog, channel, { isPing, inHelpChannel })
    .catch(() => null);
  return await applyPassageCitations(result, passages, prog, question);
}

interface KnownAnswerOptions {
  question: string;
  contextPrompt: string;
  mode: AnswerMode;
  program?: ProgramLike | string | null;
  skipCache?: boolean;
}

function knownAnswer({ question, contextPrompt, mode, program: prog = null, skipCache = false }: KnownAnswerOptions) {
  if (contextPrompt) return null;
  if (link.extractUrl(question)) return null;
  if (mode === DOCS_ONLY) return null;
  return cacheHit(question, contextPrompt, idOf(prog), skipCache);
}

export = {
  idOf,
  cacheHit,
  dateFallback,
  retrievalQuery,
  canonicalFaqQuestion,
  lookupAnswer,
  answerOrChat,
  knownAnswer,
  exactClaimAllowed,
  applyGroundingBoundary,
  suggestedSourceForQuestion,
  applyPassageCitations,
  citeTimelineFallback,
  isAuthoritativeOnlyTopic,
  numericClaimsGrounded,
};
