const VERDICTS = new Set(["supported", "unsupported", "needs_review"]);
type JsonRecord = Record<string, unknown>;
interface GroundingClaim {
  claim: string;
  supported: boolean;
  evidenceIds: string[];
}
interface ParsedVerdict {
  ok: boolean;
  verdict: string;
  claims: GroundingClaim[];
  errors: string[];
  coverage?: boolean;
}
interface EvidenceRecord extends JsonRecord {
  id?: unknown;
  programId?: unknown;
  program_id?: unknown;
  supportsClaims?: unknown;
  supportedClaims?: unknown;
}
interface ValidateOptions {
  verdict?: unknown;
  evidence?: EvidenceRecord[];
  programId?: string;
  fixtureClaims?: unknown[];
  parse?: (raw: unknown) => ParsedVerdict;
}
interface PassageCitationOptions {
  citations?: unknown[];
  evidence?: EvidenceRecord[];
  programId?: string;
}
interface PassageClaimOptions {
  verdict?: unknown;
  expectedClaims?: Array<{ claim: string; evidenceIds: string[] }>;
  evidence?: EvidenceRecord[];
  programId?: string;
}

function fail(errors: string[]): ParsedVerdict {
  return { ok: false, verdict: "unsupported", claims: [], errors };
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeJson(text: unknown): JsonRecord | null {
  const input = asString(text);
  if (!input) return null;

  const candidates: string[] = [];
  const fenced = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(input))) candidates.push(match[1].trim());
  candidates.push(input);

  for (let start = 0; start < input.length; start += 1) {
    if (input[start] !== "{" && input[start] !== "[") continue;
    let depth = 0;
    let quote = false;
    let escaped = false;
    for (let end = start; end < input.length; end += 1) {
      const character = input[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quote = false;
        continue;
      }
      if (character === '"') quote = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(input.slice(start, end + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch (_error: unknown) {}
  }
  return null;
}

function parseGroundingVerdict(raw: unknown): ParsedVerdict {
  const value = typeof raw === "string" ? decodeJson(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(["verdict must be a JSON object"]);
  const record = value as JsonRecord;
  if (typeof record.verdict !== "string" || !VERDICTS.has(record.verdict))
    return fail(["verdict must be supported, unsupported, or needs_review"]);
  if (!Array.isArray(record.claims) || record.claims.length === 0) return fail(["claims must be a non-empty array"]);

  const claims: GroundingClaim[] = [];
  for (const [index, item] of record.claims.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail([`claims[${index}] must be an object`]);
    const claimRecord = item as JsonRecord;
    const claim = asString(claimRecord.claim);
    if (!claim) return fail([`claims[${index}].claim must be a non-empty string`]);
    const evidenceIds = claimRecord.evidenceIds ?? claimRecord.passageIDs;
    if (typeof claimRecord.supported !== "boolean" && record.verdict !== "supported")
      return fail([`claims[${index}].supported must be boolean`]);
    if (!Array.isArray(evidenceIds) || evidenceIds.some((id) => !asString(id))) {
      return fail([`claims[${index}].evidenceIds must be an array of strings`]);
    }
    const supported = typeof claimRecord.supported === "boolean" ? claimRecord.supported : true;
    if (supported && evidenceIds.length === 0) return fail([`claims[${index}] supported claims need evidenceIds`]);
    claims.push({
      claim,
      supported,
      evidenceIds: evidenceIds.map((id) => asString(id)),
    });
  }
  return {
    ok: true,
    verdict: record.verdict,
    claims,
    errors: [],
    ...(typeof record.coverage === "boolean" ? { coverage: record.coverage } : {}),
  };
}

function claimKey(value: unknown) {
  return asString(value).replace(/\s+/g, " ").toLowerCase();
}

function evidenceProgramId(evidence: EvidenceRecord | undefined) {
  return asString(evidence && (evidence.programId || evidence.program_id));
}

function validateClaimSupport({
  verdict,
  evidence = [],
  programId,
  fixtureClaims = [],
  parse = parseGroundingVerdict,
}: ValidateOptions = {}) {
  if (typeof parse !== "function")
    return { ok: false, supported: false, claims: [], errors: ["parse must be a function"] };
  const parsed: ParsedVerdict =
    verdict && typeof verdict === "object" && "ok" in verdict && verdict.ok === true
      ? (verdict as ParsedVerdict)
      : parse(verdict);
  if (!parsed.ok) return { ok: false, supported: false, claims: [], errors: parsed.errors };
  if (!asString(programId)) return { ok: false, supported: false, claims: [], errors: ["programId is required"] };
  if (!Array.isArray(evidence) || !Array.isArray(fixtureClaims))
    return { ok: false, supported: false, claims: [], errors: ["evidence and fixtureClaims must be arrays"] };

  const byId = new Map(evidence.map((item) => [asString(item && item.id), item]));
  const fixtures = new Set(fixtureClaims.map(claimKey));
  const results = parsed.claims.map((claim) => {
    const explicitFixture = fixtures.has(claimKey(claim.claim));
    const validEvidence = claim.evidenceIds.every((id) => {
      const item = byId.get(id);
      if (!item || evidenceProgramId(item) !== programId) return false;
      const supportedClaims = item.supportsClaims || item.supportedClaims || [];
      return (
        Array.isArray(supportedClaims) &&
        supportedClaims.some((supported) => claimKey(supported) === claimKey(claim.claim))
      );
    });
    const supported = claim.supported && (explicitFixture || (claim.evidenceIds.length > 0 && validEvidence));
    return { claim: claim.claim, supported, reason: supported ? "explicit evidence" : "no exact same-program support" };
  });
  const supported = results.length > 0 && results.every((claim) => claim.supported);
  return { ok: true, supported, verdict: supported ? "supported" : "unsupported", claims: results, errors: [] };
}

function validatePassageCitations({ citations = [], evidence = [], programId }: PassageCitationOptions = {}) {
  if (!asString(programId) || !Array.isArray(citations) || !Array.isArray(evidence)) {
    return { ok: false, supported: false, errors: ["citations, evidence, and programId are required"] };
  }
  const byId = new Map(evidence.map((item) => [asString(item && item.id), item]));
  const supported =
    citations.length > 0 &&
    citations.every((id) => {
      const passage = byId.get(asString(id));
      return Boolean(passage && evidenceProgramId(passage) === programId);
    });
  return {
    ok: true,
    supported,
    errors: supported ? [] : ["every citation must reference a passage for the same program"],
  };
}

function validatePassageClaims({ verdict, expectedClaims = [], evidence = [], programId }: PassageClaimOptions = {}) {
  const parsed = parseGroundingVerdict(verdict);
  if (!parsed.ok || parsed.verdict !== "supported" || !asString(programId)) {
    return {
      ok: false,
      supported: false,
      errors: parsed.errors.length ? parsed.errors : ["supported verdict and programId are required"],
    };
  }
  if (!Array.isArray(expectedClaims) || !Array.isArray(evidence) || parsed.claims.length !== expectedClaims.length) {
    return { ok: false, supported: false, errors: ["verified claims must match the answer claims"] };
  }
  const evidenceIds = new Set(
    evidence.filter((item) => evidenceProgramId(item) === programId).map((item) => asString(item.id)),
  );
  const claimsSupported = expectedClaims.every((expected, index) => {
    const claim = parsed.claims[index];
    const expectedIds = [...new Set(expected.evidenceIds.map(asString))].sort();
    const actualIds = [...new Set((claim?.evidenceIds || []).map(asString))].sort();
    return Boolean(
      claim?.supported &&
      claimKey(claim.claim) === claimKey(expected.claim) &&
      actualIds.length > 0 &&
      actualIds.every((id) => evidenceIds.has(id)) &&
      (expectedIds.length === 0 ||
        (expectedIds.length === actualIds.length && expectedIds.every((id, index) => id === actualIds[index]))),
    );
  });
  return {
    ok: true,
    supported: claimsSupported,
    errors: claimsSupported ? [] : ["a claim lacks supported same-program passage evidence"],
  };
}

function createGroundingValidator({ parse = parseGroundingVerdict }: { parse?: (raw: unknown) => ParsedVerdict } = {}) {
  if (typeof parse !== "function") throw new TypeError("parse must be a function");
  return {
    parse,
    validate(input: ValidateOptions = {}) {
      return validateClaimSupport({ ...input, parse });
    },
  };
}

// A sentence ends at . ! or ? followed by whitespace and a capital letter or digit, with any passage
// citations that belong to it kept attached. Common abbreviations never end a sentence.
const SENTENCE_END = /[.!?](?:\s*\[E\d+\])*(?=\s+[A-Z0-9])/g;
const ABBREVIATION_BEFORE_PERIOD = /(?:^|[^A-Za-z])(?:e\.g|i\.e|vs|etc)$/i;

function splitAnswerSentences(text: unknown): string[] {
  const sentences: string[] = [];
  for (const line of String(text || "").split(/\n+/)) {
    let start = 0;
    for (const match of line.matchAll(SENTENCE_END)) {
      const index = match.index ?? 0;
      if (ABBREVIATION_BEFORE_PERIOD.test(line.slice(0, index))) continue;
      const end = index + match[0].length;
      sentences.push(line.slice(start, end));
      start = end;
    }
    sentences.push(line.slice(start));
  }
  return sentences.map((sentence) => sentence.trim()).filter(Boolean);
}

// Hedges such as "Assuming you mean..." frame a question rather than state a document fact.
const HEDGE_START = /^(?:assuming|if you mean|going by|i['’]m guessing)\b/i;

function isHedgeSentence(sentence: unknown) {
  return HEDGE_START.test(String(sentence || "").trim());
}

export = {
  decodeJson,
  parseGroundingVerdict,
  validateClaimSupport,
  validatePassageCitations,
  validatePassageClaims,
  createGroundingValidator,
  splitAnswerSentences,
  isHedgeSentence,
};
