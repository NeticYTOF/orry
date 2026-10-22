process.env.ORRY_SKIP_DOTENV = "1";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const config = require("./config");
const envContract = require("./envContract.cjs");

test("runtime validation and migration use the same required environment contract", () => {
  const saved = { ...process.env };
  for (const name of envContract.REQUIRED_KEYS) delete process.env[name];

  try {
    assert.deepEqual(config.missingVars({ needsSlack: true }).sort(), [...envContract.REQUIRED_KEYS].sort());
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) delete process.env[name];
    }
    Object.assign(process.env, saved);
  }
});

export {};
