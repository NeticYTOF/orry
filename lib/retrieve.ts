const log = require("./log");
const { createHash } = require("node:crypto");

type Domain = "hardware" | "software" | "general";
type Section = [string, string];
interface Chunk {
  source: string;
  heading: string | null;
  domain: Domain;
  text: string;
}
interface IndexedDoc {
  chunk: Chunk;
  freq: Map<string, number>;
  length: number;
}
interface SearchIndex {
  docs: IndexedDoc[];
  docFreq: Map<string, number>;
  avgLength: number;
}
interface ScoredChunk {
  chunk: Chunk;
  value: number;
}
interface SelectContextOptions {
  generated: Section[];
  learned?: Section[];
  index: SearchIndex;
  sources: Section[];
  question: string;
  budget?: number;
  exclude?: Set<string> | string[] | null;
  generatedLast?: boolean;
  requireEvidence?: boolean;
}

const MIN_CHUNK = 100;
const MAX_CHUNK = 900;

const DEFAULT_BUDGET = 2500;
const SEMANTIC_FALLBACK_BUDGET = 12000;

const IDENTITY_BUDGET = 2500;
const TIMELINE_BUDGET = 1200;
const LEARNED_BUDGET = 1500;
const LEARNED_MAX_FACTS = 5;
const TOTAL_CONTEXT_BUDGET = 8000;

const K1 = 1.2;
const B = 0.75;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "im",
  "my",
  "me",
  "you",
  "your",
  "we",
  "our",
  "they",
  "them",
  "do",
  "does",
  "did",
  "how",
  "what",
  "when",
  "where",
  "why",
  "who",
  "can",
  "could",
  "should",
  "would",
  "will",
  "get",
  "got",
  "have",
  "has",
  "had",
  "not",
  "no",
  "yes",
  "so",
  "just",
  "rivet",
  "whats",
  "hows",
  "wheres",
  "whens",
  "whos",
  "whys",
  "thats",
  "theres",
  "heres",
  "ive",
  "ill",
  "youre",
  "u",
  "ur",
  "pls",
  "plz",
]);

function detectDomain(text: string): Domain {
  const lowered = String(text || "").toLowerCase();
  const hasHardware =
    /\b(?:hardware|pcb|wiring\s+diagram|gerber|breadboard|soldering|schematic|cad\b|3d\s+model|\.step\b|\.stl\b|kicad|easyeda|devboard|macropad|circuit|resistor)\b/i.test(
      lowered,
    );
  const hasSoftware =
    /\b(?:software|web\s+app|website|mobile\s+app|playable\s+url|browser\s+extension|frontend|backend|npm|pypi|github\s+repo)\b/i.test(
      lowered,
    );

  if (hasHardware && !hasSoftware) return "hardware";
  if (hasSoftware && !hasHardware) return "software";
  return "general";
}

function foldPlural(token: string) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(ss|sh|ch|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(text: string): string[] {
  const rawWords = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const tokens: string[] = [];
  for (const word of rawWords) {
    if (word.includes("-")) {
      for (const part of word.split("-")) {
        if (part.length > 1 && !STOPWORDS.has(part)) {
          tokens.push(foldPlural(part));
        }
      }
      const combined = word.replace(/-/g, "");
      if (combined.length > 1 && !STOPWORDS.has(combined)) {
        tokens.push(foldPlural(combined));
      }
    } else if (word.length > 1 && !STOPWORDS.has(word)) {
      tokens.push(foldPlural(word));
    }
  }

  if (tokens.includes("old") && !tokens.includes("age")) {
    tokens.push("age");
  }
  if (tokens.includes("expiration") && !tokens.includes("expire")) {
    tokens.push("expire");
  }
  if (tokens.includes("expires") && !tokens.includes("expire")) {
    tokens.push("expire");
  }
  if (tokens.includes("resubmission") && !tokens.includes("resubmit")) {
    tokens.push("resubmit");
  }
  if (tokens.includes("returned") && !tokens.includes("return")) {
    tokens.push("return");
  }
  if (tokens.includes("return") && !tokens.includes("returned")) {
    tokens.push("returned");
  }
  if ((tokens.includes("disclosure") || tokens.includes("disclosing")) && !tokens.includes("disclose")) {
    tokens.push("disclose");
  }
  if (tokens.includes("disclose") && !tokens.includes("disclosure")) {
    tokens.push("disclosure");
  }

  return tokens;
}

function chunkSection(name: string, rawText: string): Chunk[] {
  const normalized = String(rawText || "")
    .replace(/([^\n])\n(#{1,6}\s+)/g, "$1\n\n$2")
    .replace(/([.?!])\n([A-Z0-9*-])/g, "$1\n\n$2")
    .trim();
  if (!normalized) return [];
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let buffer = "";

  const flush = () => {
    const body = buffer.trim();
    buffer = "";
    if (!body) return;
    const alreadyHasHeading = heading && (body.startsWith(heading) || body.startsWith("#") || body.includes(heading));
    const fullText = heading && !alreadyHasHeading ? `${heading}\n${body}` : body;
    chunks.push({
      source: name,
      heading,
      domain: detectDomain(fullText),
      text: fullText,
    });
  };

  for (const paragraph of paragraphs) {
    const headingMatch = paragraph.match(/^#{1,6}\s+(.+)$/m);
    if (headingMatch && paragraph.startsWith("#")) {
      flush();
      heading = headingMatch[1].trim();
    }

    if (paragraph.length > MAX_CHUNK) {
      flush();
      let piece = "";
      for (const sentence of paragraph.split(/(?<=[.!?])\s+|\n+/)) {
        if (piece && piece.length + sentence.length > MAX_CHUNK) {
          buffer = piece;
          flush();
          piece = "";
        }
        piece = piece ? `${piece}\n${sentence}` : sentence;
      }
      buffer = piece;
      flush();
      continue;
    }

    if (buffer && shouldFlushBeforeMerge(buffer, paragraph)) {
      flush();
    }

    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length > MAX_CHUNK) {
      flush();
      buffer = paragraph;
    } else {
      buffer = candidate;
      const isLeadIn = /:\s*$/.test(buffer);
      if (!isLeadIn && buffer.length >= MIN_CHUNK) {
        flush();
      }
    }
  }

  flush();
  return chunks;
}

function shouldFlushBeforeMerge(buffer: string, paragraph: string) {
  const bufDomain = detectDomain(buffer);
  const paraDomain = detectDomain(paragraph);
  const domainConflict =
    (bufDomain === "software" && paraDomain === "hardware") || (bufDomain === "hardware" && paraDomain === "software");
  if (domainConflict) return true;
  if (/:\s*$/.test(buffer)) return false;
  if (/[.?!]\s*$/.test(buffer) && buffer.length >= 60) return true;
  return buffer.length + paragraph.length > MAX_CHUNK;
}

function chunkSections(sections: Section[]) {
  return sections.flatMap(([name, text]) => chunkSection(name, text));
}

function buildIndex(chunks: Chunk[]): SearchIndex {
  const docs: IndexedDoc[] = chunks.map((chunk) => {
    const terms = tokenize(`${chunk.heading || ""} ${chunk.text}`);
    const freq = new Map<string, number>();
    for (const term of terms) freq.set(term, (freq.get(term) || 0) + 1);
    return { chunk, freq, length: terms.length };
  });

  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.freq.keys()) docFreq.set(term, (docFreq.get(term) || 0) + 1);
  }

  const totalLength = docs.reduce((sum, d) => sum + d.length, 0);
  return { docs, docFreq, avgLength: docs.length > 0 ? totalLength / docs.length : 0 };
}

function bm25TermScore(tf: number, docLength: number, avgLength: number, idf: number) {
  const norm = tf * (K1 + 1);
  const denom = tf + K1 * (1 - B + (B * docLength) / (avgLength || 1));
  return idf * (norm / denom);
}

function baseScore(
  doc: IndexedDoc,
  queryTerms: string[],
  total: number,
  docFreq: Map<string, number>,
  avgLength: number,
) {
  let value = 0;
  for (const term of queryTerms) {
    const tf = doc.freq.get(term);
    if (!tf) continue;
    const frequency = docFreq.get(term) ?? 0;
    const idf = Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5));
    value += bm25TermScore(tf, doc.length, avgLength, idf);
  }
  return value;
}

function score(index: SearchIndex, queryTerms: string[]): ScoredChunk[] {
  const { docs, docFreq, avgLength } = index;
  const total = docs.length;
  return docs
    .map((doc) => {
      const base = baseScore(doc, queryTerms, total, docFreq, avgLength);
      return { chunk: doc.chunk, value: base };
    })
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
}

function questionParts(question: string): string[] {
  const parts = (question || "")
    .split(/\?+|!+|;|\r?\n+|\.\s+(?=[A-Z])|\s+(?:and|also)\s+/i)
    .map((part) => part.trim())
    .filter((part) => tokenize(part).length > 0);
  return parts.length > 1 ? parts : [question];
}

function selectChunks(
  index: SearchIndex,
  question: string,
  budget = DEFAULT_BUDGET,
  exclude: Set<string> | string[] | null = null,
): Chunk[] {
  const rankings = questionParts(question)
    .map((part) => score(index, [...new Set(tokenize(part))]))
    .filter((ranking) => ranking.length > 0);
  const dropped = exclude instanceof Set ? exclude : new Set(exclude || []);
  const selected: Chunk[] = [];
  const seen = new Set<Chunk>();
  let used = 0;
  for (let rank = 0; ; rank++) {
    if (rankings.every((ranking) => rank >= ranking.length)) break;
    for (const ranking of rankings) {
      const chunk = ranking[rank]?.chunk;
      if (!chunk || seen.has(chunk) || dropped.has(chunk.source)) continue;
      seen.add(chunk);
      if (used + chunk.text.length <= budget) {
        selected.push(chunk);
        used += chunk.text.length;
      }
    }
  }
  return selected;
}

function passageId(chunk: Chunk) {
  return `p_${createHash("sha256")
    .update(`${chunk.source}\0${chunk.heading || ""}\0${chunk.text}`)
    .digest("hex")}`;
}

function selectEvidence(
  index: SearchIndex,
  question: string,
  budget = DEFAULT_BUDGET,
  exclude: Set<string> | string[] | null = null,
  semanticFallback = true,
) {
  let chunks = selectChunks(index, question, budget, exclude);
  if (chunks.length === 0 && semanticFallback) {
    const dropped = exclude instanceof Set ? exclude : new Set(exclude || []);
    const groups = new Map<string, Chunk[]>();
    for (const { chunk } of index.docs) {
      if (dropped.has(chunk.source)) continue;
      const group = groups.get(chunk.source) || [];
      group.push(chunk);
      groups.set(chunk.source, group);
    }
    const priority = (source: string) =>
      /faq|frequently asked/i.test(source) ? 0 : /website|site|docs/i.test(source) ? 1 : 2;
    const ordered = [...groups].sort((a, b) => priority(a[0]) - priority(b[0]));
    chunks = [];
    let used = 0;
    const add = (chunk: Chunk) => {
      if (used + chunk.text.length > SEMANTIC_FALLBACK_BUDGET) return false;
      chunks.push(chunk);
      used += chunk.text.length;
      return true;
    };

    for (const [source, sourceChunks] of ordered) {
      if (priority(source) !== 0) continue;
      for (const chunk of sourceChunks) add(chunk);
    }
    for (let rank = 0; ; rank++) {
      let found = false;
      for (const [source, sourceChunks] of ordered) {
        if (priority(source) === 0) continue;
        const chunk = sourceChunks[rank];
        if (!chunk) continue;
        found = true;
        add(chunk);
      }
      if (!found || used >= SEMANTIC_FALLBACK_BUDGET) break;
    }
  }
  return chunks.map((chunk) => ({
    id: passageId(chunk),
    source: chunk.source,
    heading: chunk.heading,
    text: chunk.text,
  }));
}

function selectContext({
  generated,
  learned = [],
  index,
  sources,
  question,
  budget = DEFAULT_BUDGET,
  exclude = null,
  generatedLast = false,
  requireEvidence = false,
}: SelectContextOptions) {
  const dropped = exclude instanceof Set ? exclude : new Set(exclude || []);
  const kept = ([name]: Section) => !dropped.has(name);

  const budgetFor = (name: string) => {
    if (name.toLowerCase().startsWith("about ")) return IDENTITY_BUDGET;
    if (name === "Program timeline") return TIMELINE_BUDGET;
    if (name === "Learned answers") return LEARNED_BUDGET;
    return TIMELINE_BUDGET;
  };
  const render = ([name, text]: Section) => `### ${name}\n${String(text || "").slice(0, budgetFor(name))}`;
  const renderLearned = ([name, text]: Section) => `### ${name}\n${String(text || "").slice(0, LEARNED_BUDGET)}`;

  const head = generated
    .filter(kept)
    .filter(([, text]) => text)
    .map(render);
  const learnedSections = learned
    .filter(kept)
    .filter(([, text]) => text)
    .map(renderLearned);
  const first = [...head, ...learnedSections];
  const order = (retrieved: string[]) =>
    (generatedLast ? [...retrieved, ...first] : [...first, ...retrieved]).join("\n\n");
  const enforceTotal = (text: string) =>
    text.length > TOTAL_CONTEXT_BUDGET ? text.slice(0, TOTAL_CONTEXT_BUDGET) : text;

  const chunks = selectChunks(index, question, budget, dropped);
  if (chunks.length === 0) {
    if (requireEvidence) return enforceTotal(order([]));
    log.debug("retrieve", `no chunk matched "${(question || "").slice(0, 60)}" — sending capped corpus`);
    let used = 0;
    const capped: string[] = [];
    for (const [name, text] of sources.filter(kept)) {
      if (used >= budget) break;
      const slice = text.slice(0, Math.max(200, budget - used));
      capped.push(`### ${name}\n${slice}`);
      used += slice.length;
    }
    return enforceTotal(order(capped));
  }

  const bySource = new Map<string, string[]>();
  for (const chunk of chunks) {
    const texts = bySource.get(chunk.source) || [];
    texts.push(chunk.text);
    bySource.set(chunk.source, texts);
  }

  const body = [...bySource].map(([name, texts]) => `### ${name}\n${texts.join("\n\n")}`);
  return enforceTotal(order(body));
}

export = {
  tokenize,
  foldPlural,
  detectDomain,
  chunkSection,
  chunkSections,
  buildIndex,
  score,
  selectChunks,
  selectEvidence,
  selectContext,
  MIN_CHUNK,
  MAX_CHUNK,
  DEFAULT_BUDGET,
  SEMANTIC_FALLBACK_BUDGET,
  IDENTITY_BUDGET,
  TIMELINE_BUDGET,
  LEARNED_BUDGET,
  LEARNED_MAX_FACTS,
  TOTAL_CONTEXT_BUDGET,
  K1,
  B,
};
