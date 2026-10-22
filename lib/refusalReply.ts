// Situation-aware copy for replies where a person should take over.
// Pure helpers: no Slack or database calls.

const elig = require("./eligibility");

type RefusalReason = "code" | "decision" | "account" | "default";

// Words that mean the question is about code. These win over account and
// decision wording only when the question is not a plain policy request.
const STRONG_CODE_RES =
  /\b(?:python|java|javascript|typescript|rust|golang|php|sql|code|coding|function|functions|method|class|variable|variables|stack\s?trace|traceback|compile|compiler|import|library|api|esp32|arduino|wifi|syntax|module)\b/i;
// Words that often appear in code questions but can also describe an account problem.
const WEAK_CODE_RES = /\b(?:exception|exceptions|error|errors|throw|throws|catch|raise|raised)\b/i;
// Approval and grant wording: a human has to decide these.
const DECISION_WORDS_RES = /\b(?:approve|approval|approved|grant|grants|waiver|waive)\b/i;

// Classifies a question for the refusal copy. Decision and account checks reuse
// the eligibility rules, so both agree on what counts as a human-only request.
function refusalReason(text: unknown): RefusalReason {
  const body = String(text || "").trim();
  if (!body) return "default";
  if (!elig.technicalContext(body) && (elig.policyExceptionRequest(body) || DECISION_WORDS_RES.test(body))) {
    return "decision";
  }
  if (STRONG_CODE_RES.test(body)) return "code";
  if (elig.accountRequest(body)) return "account";
  if (WEAK_CODE_RES.test(body)) return "code";
  return "default";
}

function programName(program: unknown): string {
  const name = (program as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name.trim() : "";
}

// Returns one short, plain sentence for the reason. The program name is used
// only when the program provides one; no channel names are ever invented.
function refusalText(reason: unknown, { program = null }: { program?: unknown } = {}): string {
  const name = programName(program);
  switch (reason) {
    case "code":
      return name
        ? `Sorry, I can't help with code here, but the ${name} team can point you in the right direction. That's deeper than my tunnels.`
        : "Sorry, I can't help with code here, but a helper or organizer can point you in the right direction. That's deeper than my tunnels.";
    case "decision":
      return name
        ? `That's a call for a person, not a mine-mole. The ${name} team will get back to you soon.`
        : "That's a call for a person, not a mine-mole. A helper or organizer will get back to you soon.";
    case "account":
      return name
        ? `Leider, I can't look into your account from here. The ${name} team can sort it out with you.`
        : "Leider, I can't look into your account from here. A helper or organizer can sort it out with you.";
    default:
      return name
        ? `I'm not the right one for that one, wrong tunnel and all. The ${name} team can take a look.`
        : "I'm not the right one for that one, wrong tunnel and all. A helper or organizer can take a look.";
  }
}

// The same copy for a question that also pinged a helper, plus one clause saying
// a helper has been pinged to look. This is the only variant that claims a notification.
function pingedRefusalText(reason: unknown, { program = null }: { program?: unknown } = {}): string {
  return `${refusalText(reason, { program })} I've pinged a helper to take a look.`;
}

export = {
  refusalText,
  refusalReason,
  pingedRefusalText,
};
