/* The site's own, narrow approximation of a "sensitive topic" check on question text (PLAN 2.4 rule 4).
   Written fresh for the site; it is NOT the bot's `sensitiveHit` and must never be described as Orry's detection.
   When it matches, the server removes the question text from every response until a logged reveal. */

const PATTERNS: RegExp[] = [
  // asking for a person instead of the bot
  /\b(talk|speak|chat)\s+(to|with)\s+(a|an|some)?\s*(real\s+)?(human|person|adult|grown[- ]?up|organi[sz]er|someone)\b/i,
  /\b(rather|want to|need to)\s+(talk|speak)\s+to\s+(a\s+)?(human|person|someone)\b/i,
  /\bnot\s+(the|a)\s+bot\b.*\b(person|human)\b|\b(person|human)\b.*\bnot\s+(the|a)\s+bot\b/i,
  // harm to self or others, unsafe situations
  /\b(hurt(ing)?|harm(ing)?)\s+(myself|themselves|himself|herself)\b/i,
  /\bself[- ]?harm\b/i,
  /\b(suicid\w*|kill\s+myself|end\s+my\s+life)\b/i,
  /\b(unsafe|not\s+safe|scared)\s+(at\s+home|at\s+school|around)\b/i,
  /\b(harass\w*|bull(y|ied|ying)|threaten\w*|groom\w*)\b/i
];

export function looksSensitive(text: string | null | undefined): boolean {
  if (!text) return false;
  return PATTERNS.some(p => p.test(text));
}

/** The copy the board shows instead of the text (PLAN 4.0 copy deck). */
export const SENSITIVE_BOARD_COPY = "Sensitive topic. Open the ticket to read it.";
