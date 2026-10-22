process.env.ORRY_SKIP_DOTENV = "1";
process.env.OPENCODE_API_KEY = "zen-test-key";
process.env.HCAI_API_KEY = "hcai-test-key-1";
process.env.HCAI_API_KEY_2 = "hcai-test-key-2";
process.env.HCAI_BASE_URL = "https://ai.example.test/v1";
process.env.HCAI_MODEL = "hcai-answer-model";
process.env.HCAI_PING_MODEL = "hcai-ping-model";
process.env.HCAI_HELP_MODEL = "hcai-help-model";
process.env.HCAI_INTENT_MODEL = "hcai-intent-model";
process.env.HCAI_VISION_MODEL = "hcai-vision-model";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("./config");

test("documented HCAI task model overrides route through the pooled provider", () => {
  const expected = [
    [config.answer, "hcai-answer-model"],
    [config.pingAnswer, "hcai-ping-model"],
    [config.helpAnswer, "hcai-help-model"],
    [config.intent, "hcai-intent-model"],
    [config.vision, "hcai-vision-model"],
  ] as const;

  for (const [tier, model] of expected) {
    assert.equal(tier.baseUrl, "https://ai.example.test/v1", `${model} should use HCAI`);
    assert.equal(tier.model, model);
    assert.ok(["hcai-test-key-1", "hcai-test-key-2"].includes(tier.apiKey()));
    assert.ok(tier.fallback);
  }

  const first = config.helpAnswer.apiKey();
  const second = config.helpAnswer.apiKey();
  assert.notEqual(first, second, "per-task HCAI tiers should use the shared rotating key pool");
});

export {};
