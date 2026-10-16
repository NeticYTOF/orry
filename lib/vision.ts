const axios = require("axios");
const { config } = require("./config");
const { complete } = require("./llm");
const { normalizeEmoji, VOICE } = require("./answer");
const brand = require("./brand");
const log = require("./log");

const MAX_TOKENS = 500;
const TIMEOUT_MS = 30000;
const SLACK_FILE_HOST = "https://files.slack.com/";
const SLACK_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_QUESTION = "can you help with this?";

async function fetchSlackImageAsDataUri(imageUrl: string, slackToken: string | null) {
  const res = await axios.get(imageUrl, {
    headers: { Authorization: `Bearer ${slackToken}` },
    responseType: "arraybuffer",
    timeout: SLACK_FETCH_TIMEOUT_MS,
  });
  const base64 = Buffer.from(res.data, "binary").toString("base64");
  const contentType = res.headers["content-type"] || "image/png";
  return `data:${contentType};base64,${base64}`;
}

function needsSlackFetch(imageUrl: string, slackToken: string | null | undefined) {
  return imageUrl.startsWith(SLACK_FILE_HOST) && !!slackToken;
}

const SKIP = "SKIP";

function visionSystemPrompt(context: string, docs = "", requireGrounded = false) {
  return [
    `You are ${brand.name()}, a helper in a support channel. Someone shared an image.`,
    ...VOICE,
    "Answer their question or fix the problem the image shows, like a friendly human helper would.",
    "Never describe or summarize the image. Don't list what you see.",
    "Use plain words, usually one or two short sentences. Include short steps or code when needed to explain the fix clearly, without unrelated detail.",
    "If it's an error, say what's wrong and the fix. If they asked something, answer it.",
    "Program facts (deadlines, rules, prices, how things work) come only from the docs below. Never invent them.",
    `If there's no clear question or problem, or you aren't confident you know the answer, reply with exactly ${SKIP}.`,
    context ? `Conversation so far: ${context}` : "",
    docs ? `Docs:\n${docs}` : "",
    requireGrounded
      ? 'For questions about program facts or rules, include direct proof in this exact format: put DOC_SUPPORT: "exact source sentence" on one line and ANSWER: your brief answer on the next. The quoted sentence must appear verbatim in Docs. If Docs do not directly support the answer, reply exactly SKIP. General code debugging based on the image remains allowed without DOC_SUPPORT.'
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function analyzeImage(
  imageUrl: string,
  question: string,
  context = "",
  slackToken: string | null = null,
  docs = "",
  requireGrounded = false,
) {
  let finalImageUrl = imageUrl;
  if (needsSlackFetch(imageUrl, slackToken)) {
    try {
      finalImageUrl = await fetchSlackImageAsDataUri(imageUrl, slackToken);
    } catch (error: unknown) {
      log.error("vision", "failed to fetch Slack image:", error instanceof Error ? error.message : String(error));
      throw new Error("couldn't grab that image from Slack");
    }
  }

  const { text } = await complete(
    {
      baseUrl: config.vision.baseUrl,
      apiKey: config.vision.apiKey,
      model: config.vision.model,
      fallback: config.vision.fallback,
      onRateLimited: config.vision.onRateLimited,
      maxTokens: MAX_TOKENS,
      timeout: TIMEOUT_MS,
      messages: [
        { role: "system", content: visionSystemPrompt(context, docs, requireGrounded) },
        {
          role: "user",
          content: [
            { type: "text", text: question || DEFAULT_QUESTION },
            { type: "image_url", image_url: { url: finalImageUrl } },
          ],
        },
      ],
    },
    "vision",
  );

  const reply = text?.trim();
  if (!reply || reply.replace(/[.!\s]/g, "").toUpperCase() === SKIP) return null;
  return normalizeEmoji(reply);
}

function generalCodeDebugQuestion(question: string) {
  if (
    /\b(?:deadline|launch|released?|prize|award|reward|grant|eligib\w*|policy|rule|join|submi(?:t|ssion)|price|cost|how much|program|loadout)\b/i.test(
      question,
    )
  ) {
    return false;
  }
  const hasDebugIntent =
    /\b(?:debug|fix|broken|wrong|why|explain|error|exception|stack trace|build fail(?:ed|ing)?)\b/i.test(question);
  const hasCodeContext =
    /\b(?:typescript|javascript|python|rust|java|compiler|stack trace|exception|code|function|variable|syntax|runtime)\b/i.test(
      question,
    );
  return hasDebugIntent && hasCodeContext;
}

function groundedImageReply(reply: string, question: string, docs: string): string | null {
  if (generalCodeDebugQuestion(question)) return reply.trim();
  const match = reply.match(/^\s*DOC_SUPPORT:\s*["“]([^"”\r\n]{12,})["”]\s*\r?\nANSWER:\s*([\s\S]+?)\s*$/i);
  if (!match || !docs.trim()) return null;
  const quote = match[1].replace(/\s+/g, " ").trim();
  const normalizedDocs = docs.replace(/\s+/g, " ").toLowerCase();
  if (!normalizedDocs.includes(quote.toLowerCase())) return null;
  return quote;
}

function isGroundedImageReply(reply: string, question: string, docs: string) {
  return groundedImageReply(reply, question, docs) !== null;
}

export = { analyzeImage, visionSystemPrompt, isGroundedImageReply, groundedImageReply };
