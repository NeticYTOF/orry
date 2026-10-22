process.env.ORRY_SKIP_DOTENV = "1";
process.env.ORRY_DB_PATH = ":memory:";
process.env.OPENCODE_API_KEY = "zen-test-key";
delete process.env.HCAI_API_KEY;
delete process.env.HCAI_API_KEY_2;
delete process.env.HCAI_INTENT_MODEL;
delete process.env.INTENT_CLASSIFIER_MODEL;
delete process.env.INTENT_REASONING_EFFORT;
delete process.env.GROQ_API_KEY;

const { test } = require("node:test");
const assert = require("node:assert/strict");
const intent = require("./intent");
const llm = require("./llm");

test("unprompted intent classification uses the tested fast default with low reasoning", async () => {
  const savedComplete = llm.complete;
  let request: any = null;
  llm.complete = async (options: any) => {
    request = options;
    return {
      text: JSON.stringify({
        verdict: "HELP_NEEDED",
        addressedToOrry: false,
        directedAtHuman: false,
        recentOrryParticipation: false,
        programRelevance: "relevant",
      }),
    };
  };

  try {
    const result = await intent.classifyIntentContext("how do i submit", null, { history: [], returnContext: true });
    assert.equal(result.verdict, intent.HELP_NEEDED);
  } finally {
    llm.complete = savedComplete;
  }

  assert.equal(request.model, "gpt-4.1-nano");
  assert.equal(request.reasoningEffort, "low");
});

export {};
