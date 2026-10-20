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

const NUMERIC_CLAIM_RE =
  /\$\s?\d[\d,.]*|\b\d[\d,.]*\s?%|\b\d[\d,.]*\s?(?:percent|px|pixels?|hours?|hrs?|days?|weeks?|months?|dollars?|points?|bolts?|xp)\b/gi;

function normalizeForMatch(text: string) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function numericClaimsGrounded(answerText: string, corpusText: string) {
  if (!corpusText) return true;
  const claims = String(answerText || "").match(NUMERIC_CLAIM_RE) || [];
  if (claims.length === 0) return true;
  const corpusNorm = normalizeForMatch(corpusText);
  return claims.every((claim) => corpusNorm.includes(normalizeForMatch(claim)));
}

function evidencePrompt(passages: Array<{ id: string; source: string; heading?: string; text: string }>) {
  return passages
    .map(
      ({ source, heading, text }, index) => `### ${source} [E${index + 1}]${heading ? ` — ${heading}` : ""}\n${text}`,
    )
    .join("\n\n");
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
  const ids = new Map<string, string>();
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
    ids.set(passage.id, `E${index + 1}`);
  }
  const separated = separateExplicitUncertainty(String(result.answer || ""), question);
  if (!result.unresolved?.length && separated.unresolved.length) result.unresolved = separated.unresolved;
  const answerText = separated.answer;
  const refs = [...answerText.matchAll(/\[(E\d+)\]/g)];
  for (const match of refs) {
    const alias = match[1];
    const id = aliases.get(alias);
    if (!id) return null;
  }
  const sentenceParts = answerText.split(/(?<=[.!?])\s+(?!\[E\d+\])|(?<=\])\s+(?!\[E\d+\])|\n+/).filter(Boolean);
  const claims = sentenceParts.map((sentence) => {
    const claim = sentence
      .replace(/\[E\d+\]/g, "")
      .trim()
      .replace(/\s+([.,!?;:])/g, "$1");
    const citedIds = [...sentence.matchAll(/\[(E\d+)\]/g)].map((match) => aliases.get(match[1]) || "");
    return { claim, supported: true, evidenceIds: [...new Set(citedIds)] };
  });
  if (!claims.length || claims.some(({ claim }) => !claim)) return null;

  const verificationEvidence = [...eligible.values()].map((passage) => ({ ...passage, programId }));
  const expectedClaims = claims.map(({ claim, evidenceIds }) => ({ claim, evidenceIds }));
  const needsCoverage = Boolean(question || result.unresolved?.length);
  const verdict = await answer.verifyGrounding(expectedClaims, verificationEvidence, prog, null, {
    ...(needsCoverage ? { requestCoverage: { question, contextQuestion, unresolved: result.unresolved || [] } } : {}),
  });
  const verified = grounding.parseGroundingVerdict(verdict);
  if (
    !verified.ok ||
    verified.claims.length !== expectedClaims.length ||
    verified.claims.some(
      (claim, index) =>
        claim.claim.trim().replace(/\s+/g, " ").toLowerCase() !== expectedClaims[index].claim.toLowerCase(),
    )
  )
    return null;
  const supportedIndexes = verified.claims.flatMap((claim, index) => (claim.supported ? [index] : []));
  if (!supportedIndexes.length || (supportedIndexes.length !== verified.claims.length && !result.unresolved?.length))
    return null;
  const supportedClaims = supportedIndexes.map((index) => verified.claims[index]);
  const supportedExpectedClaims = supportedIndexes.map((index) => expectedClaims[index]);
  const checkedClaims = grounding.validatePassageClaims({
    verdict: { ...verified, verdict: "supported", claims: supportedClaims },
    expectedClaims: supportedExpectedClaims,
    evidence: verificationEvidence,
    programId,
  });
  if (!checkedClaims.supported) return null;
  if (needsCoverage) {
    let coverage = verified.coverage === true;
    if (supportedIndexes.length !== verified.claims.length) {
      const coverageVerdict = grounding.parseGroundingVerdict(
        await answer.verifyGrounding(supportedExpectedClaims, verificationEvidence, prog, null, {
          requestCoverage: { question, contextQuestion, unresolved: result.unresolved || [] },
        }),
      );
      coverage = Boolean(
        coverageVerdict.ok &&
        coverageVerdict.coverage === true &&
        coverageVerdict.claims.length === supportedExpectedClaims.length &&
        coverageVerdict.claims.every(
          (claim, index) =>
            claim.supported &&
            claim.claim.trim().replace(/\s+/g, " ").toLowerCase() ===
              supportedExpectedClaims[index].claim.toLowerCase(),
        ) &&
        grounding.validatePassageClaims({
          verdict: { ...coverageVerdict, verdict: "supported" },
          expectedClaims: supportedExpectedClaims,
          evidence: verificationEvidence,
          programId,
        }).supported,
      );
    }
    if (!coverage) {
      log.debug("grounding", "answer did not cover the current question and unresolved parts");
      return null;
    }
  }
  const supportedSentences = supportedIndexes.map((index) => sentenceParts[index]);
  const usedIds = new Set(supportedClaims.flatMap((claim) => claim.evidenceIds));
  const validity = grounding.validatePassageCitations({
    citations: [...usedIds],
    evidence: verificationEvidence,
    programId,
  });
  if (!validity.supported) return null;
  const cited = new Map([...usedIds].map((id) => [String(id), eligible.get(String(id))!]));
  result.answer = supportedSentences
    .map((sentence, index) => {
      const claim = claims[supportedIndexes[index]].claim;
      if (
        !numericClaimsGrounded(claim, supportedClaims[index].evidenceIds.map((id) => eligible.get(id)!.text).join("\n"))
      )
        return "";
      return claim;
    })
    .join(" ");
  if (!result.answer) return null;
  result.source = cited.values().next().value?.source || result.source;
  result.citationEvidence = [...cited.values()];
  result.passageCitations = [...cited.keys()];
  if (result.unresolved?.length) {
    result.answer += `\n\nI couldn't confirm ${result.unresolved.join("; ")} in the docs, so I can't answer those parts.`;
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
  return numericClaimsGrounded(result.answer || "", corpus);
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

function retrievalQuery(question: string, contextPrompt = "", prog: ProgramLike | string | null = null) {
  let q = (question || "").trim();
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
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, cacheScope(prog), skipCache);
  if (hit) return hit;

  const staged = await runCodeStages(question);
  if (staged) return staged;

  const query = retrievalQuery(question, contextPrompt, prog);
  const { passages } = knowledge.getEvidenceContext(query, programId);
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
  const programId = idOf(prog);
  const hit = previousQuestion ? null : cacheHit(question, contextPrompt, cacheScope(prog), skipCache);
  if (hit) return hit;

  const staged = await runCodeStages(question);
  if (staged) return staged;

  const query = previousQuestion
    ? retrievalQuery(question, `User: ${previousQuestion}`, prog)
    : retrievalQuery(question, contextPrompt, prog);
  const { passages } = knowledge.getEvidenceContext(query, programId);
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
