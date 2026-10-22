// Verifies the env contract and diff shared with scripts/migrate-railway.mjs.
//
// Run with: node scripts/test-diff.mjs
// (No network or environment needed — pure logic.)

import envContract from "../lib/envContract.cjs";

const { MODEL_VARS, SLACK_VARS, REQUIRED_KEYS: REQUIRED, OPTIONAL_KEYS: OPTIONAL, diff } = envContract;
const BASE_VARS = {
  OPENCODE_API_KEY: "x",
  SLACK_BOT_TOKEN: "x",
  SLACK_APP_TOKEN: "x",
  SLACK_FAQ_CHANNELS: "x",
};

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("  ok", name); }
  else { fail++; console.error("  FAIL", name, "\n    got:", got, "\n    want:", want); }
}

eq("required migration vars share the runtime model and Slack groups", REQUIRED, [...MODEL_VARS, ...SLACK_VARS]);

eq("help channel and HCAI key are optional", [
  OPTIONAL.includes("SLACK_HELP_CHANNEL"),
  REQUIRED.includes("HCAI_API_KEY"),
  OPTIONAL.includes("HCAI_API_KEY"),
], [true, false, true]);

eq("identical is empty",
  diff({ ...BASE_VARS }, { ...BASE_VARS }),
  { missing: [], mismatch: [], unexpected: [], extra: [], wouldSet: [] });

eq("required key missing in FILE is reported",
  diff({ SLACK_BOT_TOKEN: "x" }, { SLACK_BOT_TOKEN: "x" }).missing,
  ["OPENCODE_API_KEY", "SLACK_APP_TOKEN", "SLACK_FAQ_CHANNELS"]);

eq("mismatch detected",
  diff(
    { ...BASE_VARS, HCAI_API_KEY: "OLD" },
    { ...BASE_VARS, HCAI_API_KEY: "NEW" },
  ).mismatch.map((m) => m.key),
  ["HCAI_API_KEY"]);

eq("new optional becomes wouldSet",
  diff(
    { ...BASE_VARS, HCAI_API_KEY: "x" },
    { ...BASE_VARS, HCAI_API_KEY: "x", ORRY_DB_PATH: "/data/rivet.db" },
  ).wouldSet,
  ["ORRY_DB_PATH"]);

eq("set on current but blank in file -> extra",
  diff(
    { ...BASE_VARS, HCAI_API_KEY: "x", ORRY_FEEDBACK_REACTIONS: "yesyes" },
    { ...BASE_VARS, HCAI_API_KEY: "x" },
  ).extra,
  ["ORRY_FEEDBACK_REACTIONS"]);

eq("typo flagged as unexpected",
  diff(
    { ...BASE_VARS },
    { ...BASE_VARS, ORRY_BUG: "typo" },
  ).unexpected,
  ["ORRY_BUG"]);

eq("a numbered HCAI key is accepted by the migration contract",
  diff(
    { ...BASE_VARS, HCAI_API_KEY: "x" },
    { ...BASE_VARS, HCAI_API_KEY: "x", HCAI_API_KEY_2: "y" },
  ).unexpected,
  []);

eq("a numbered OpenCode key is accepted by the migration contract",
  diff(
    { ...BASE_VARS, OPENCODE_API_KEY_2: "x" },
    { ...BASE_VARS, OPENCODE_API_KEY_2: "x" },
  ).unexpected,
  []);

console.log("\n" + (fail === 0 ? "all pass" : `${fail} fail`));
process.exit(fail > 0 ? 1 : 0);
