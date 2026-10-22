// DRAFT COPY: review wording and resources with a person before shipping.

type CrisisResource = { label: string; detail: string };

const MAX_LENGTH = 500;

// Plain-language support message. It deliberately contains no phone numbers or
// URLs: any contact details come only from the program's crisisResources list.
const BASE_REPLY = [
  "I'm glad you said something. You don't have to handle this alone.",
  "Please reach out to someone you trust right now, like a family member, a friend, a teacher, or a counselor, and tell them what you told me.",
  "If you are in immediate danger or might act on these thoughts, call your local emergency number now.",
].join(" ");

function validResources(resources: unknown): CrisisResource[] {
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const label = typeof (entry as CrisisResource).label === "string" ? (entry as CrisisResource).label.trim() : "";
    const detail = typeof (entry as CrisisResource).detail === "string" ? (entry as CrisisResource).detail.trim() : "";
    return label && detail ? [{ label, detail }] : [];
  });
}

// Builds the in-thread supportive reply. Program-configured resources are
// appended verbatim, whole entries at a time, and any entry that would push the
// reply past 500 characters is dropped rather than truncated.
function buildCrisisReply(crisisResources: unknown = []): string {
  let text = BASE_REPLY;
  for (const { label, detail } of validResources(crisisResources)) {
    const line = `${label}: ${detail}`;
    const candidate = `${text}\n\n${line}`;
    if (candidate.length <= MAX_LENGTH) text = candidate;
  }
  return text;
}

export = {
  buildCrisisReply,
  MAX_LENGTH,
};
