const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const vision = require("./vision");

type AxiosResponseBody = { messages: Array<{ content: Array<{ image_url: { url: string } }> }> };
let realPost: typeof axios.post;
let realGet: typeof axios.get;
before(() => {
  realPost = axios.post;
  realGet = axios.get;
});
after(() => {
  axios.post = realPost;
  axios.get = realGet;
});

test("system prompt answers instead of describing, and allows skipping", () => {
  const withCtx = vision.visionSystemPrompt("order #12 stuck", "Refunds take 5 days.");
  assert.match(withCtx, /order #12 stuck/);
  assert.match(withCtx, /Refunds take 5 days/);
  assert.match(withCtx, /Never describe or summarize the image/);
  assert.match(withCtx, /reply with exactly SKIP/);
  assert.match(withCtx, /never output profanity or swear words of any kind/i);
  assert.match(withCtx, /Keep Orry's personality lightly present in casual conversation/i);
  const bare = vision.visionSystemPrompt("");
  assert.doesNotMatch(bare, /Conversation so far:|Docs:/);
});

test("grounded image policy requires a verbatim docs proof for program facts", () => {
  assert.equal(vision.isGroundedImageReply("The deadline is Friday.", "when is the deadline?", ""), false);
  assert.equal(
    vision.isGroundedImageReply("Use the Launchpad rubric.", "what rubric?", "The Launchpad rubric has five criteria."),
    false,
  );
  assert.equal(
    vision.isGroundedImageReply(
      'DOC_SUPPORT: "The Launchpad rubric has five criteria."\nANSWER: Use the Launchpad rubric.',
      "what rubric?",
      "The Launchpad rubric has five criteria.",
    ),
    true,
  );
  assert.equal(
    vision.groundedImageReply(
      'DOC_SUPPORT: "The Launchpad rubric has five criteria."\nANSWER: Actually, it has eight.',
      "what rubric?",
      "The Launchpad rubric has five criteria.",
    ),
    "The Launchpad rubric has five criteria.",
    "the sent factual text is the verbatim supported source sentence",
  );
});

test("grounded image policy permits clear coding help but does not treat any error word as coding", () => {
  assert.equal(
    vision.isGroundedImageReply(
      "Use the shown variable before it is assigned.",
      "Why does this TypeScript compiler error happen?",
      "",
    ),
    true,
  );
  assert.equal(
    vision.isGroundedImageReply("The error is that the deadline passed.", "what error says the deadline?", ""),
    false,
  );
});

test("grounded image prompt preserves general coding help", () => {
  const prompt = vision.visionSystemPrompt("", "", true);
  assert.match(prompt, /General code debugging based on the image remains allowed/);
  assert.match(prompt, /reply exactly SKIP/);
});

test("a SKIP reply means say nothing", async () => {
  for (const content of ["SKIP", "skip.", " SKIP! "]) {
    axios.post = async () => ({ data: { choices: [{ message: { content } }] } });
    assert.equal(await vision.analyzeImage("https://example.com/a.png", "hmm"), null);
  }
});

test("Slack fetch failure surfaces a friendly error, never the raw axios error", async () => {
  axios.get = async () => {
    throw new Error("403 forbidden");
  };
  axios.post = async () => {
    throw new Error("must not reach the model");
  };
  try {
    await assert.rejects(
      () => vision.analyzeImage("https://files.slack.com/files-pri/T1-F1/blob.png", "what is this?", "", "xoxb-test"),
      /couldn't grab that image from Slack/,
    );
  } finally {
    axios.get = realGet;
    axios.post = realPost;
  }
});

test("public URLs skip the Slack fetch entirely", async () => {
  let fetched = false;
  axios.get = async () => {
    fetched = true;
    throw new Error("must not fetch");
  };
  axios.post = async () => ({ data: { choices: [{ message: { content: "a cat diagram  " } }] } });
  try {
    const reply = await vision.analyzeImage("https://example.com/cat.png", "what is this?");
    assert.equal(reply, "a cat diagram");
    assert.equal(fetched, false);
  } finally {
    axios.get = realGet;
    axios.post = realPost;
  }
});

test("empty model replies resolve to null, not empty strings", async () => {
  axios.post = async () => ({ data: { choices: [{ message: { content: "   " } }] } });
  try {
    assert.equal(await vision.analyzeImage("https://example.com/x.png", "q?"), null);
  } finally {
    axios.post = realPost;
  }
});

test("Slack files inline as data URIs with the bot token", async () => {
  let sawAuth: string | undefined;
  let sawBody: AxiosResponseBody | null = null;
  axios.get = async (_url: string, opts: { headers?: { Authorization?: string } }) => {
    sawAuth = opts?.headers?.Authorization;
    return { data: Buffer.from("bytes"), headers: { "content-type": "image/png" } };
  };
  axios.post = async (_url: string, body: AxiosResponseBody) => {
    sawBody = body;
    return { data: { choices: [{ message: { content: "ok" } }] } };
  };
  try {
    await vision.analyzeImage("https://files.slack.com/files-pri/T1-F1/x.png", "q?", "", "xoxb-tok");
    assert.equal(sawAuth, "Bearer xoxb-tok");
    if (!sawBody) throw new Error("model body was not captured");
    const body = sawBody as AxiosResponseBody;
    const imgUrl = body.messages[1].content[1].image_url.url;
    assert.match(imgUrl, /^data:image\/png;base64,/);
  } finally {
    axios.get = realGet;
    axios.post = realPost;
  }
});
export {};
