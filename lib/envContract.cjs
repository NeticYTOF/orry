const MODEL_VARS = ["OPENCODE_API_KEY"];
const SLACK_VARS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_FAQ_CHANNELS"];
const REQUIRED_KEYS = [...MODEL_VARS, ...SLACK_VARS];

const OPTIONAL_KEYS = [
  "BASE_URL",
  "CRON_SECRET",
  "DATABASE_URL",
  "EXPERIENTIAL_API_KEY",
  "FIRECRAWL_API_KEY",
  "GROQ_API_KEY",
  "GROQ_MODEL",
  "HCAI_API_KEY",
  "HCAI_BASE_URL",
  "HCAI_HELP_MODEL",
  "HCAI_INTENT_MODEL",
  "HCAI_MODEL",
  "HCAI_PING_MODEL",
  "HCAI_VISION_MODEL",
  "HCA_CLIENT_ID",
  "HCA_CLIENT_SECRET",
  "INTENT_CLASSIFIER_API_KEY",
  "INTENT_CLASSIFIER_BASE_URL",
  "INTENT_CLASSIFIER_MODEL",
  "INTENT_MAX_TOKENS",
  "INTENT_REASONING_EFFORT",
  "INTENT_TIMEOUT_MS",
  "JEV_API_KEY",
  "JEV_BASE_URL",
  "JEV_CACHE_TTL_MS",
  "JEV_ENABLED",
  "JEV_ENGAGE_THRESHOLD",
  "JEV_MODEL",
  "JEV_TIMEOUT_MS",
  "NODE_ENV",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
  "OPENCODE_BASE_URL",
  "PORT",
  "REFRESH_INTERVAL_MIN",
  "RIVET_ADMIN_USER_IDS",
  "RIVET_ANSWER_API_KEY",
  "RIVET_ANSWER_BASE_URL",
  "RIVET_BOT_ALIASES",
  "RIVET_BOT_NAME",
  "RIVET_BOT_SLUG",
  "RIVET_CORE_BASE_URL",
  "RIVET_DASHBOARD_PASSCODE",
  "RIVET_DB_PATH",
  "RIVET_DEBUG",
  "RIVET_DEMO_LOGIN",
  "RIVET_DEV_SLACK_ID",
  "RIVET_EMOJI",
  "RIVET_ESCALATE_REACTION",
  "RIVET_FALLBACK_MODEL",
  "RIVET_FEEDBACK_REACTIONS",
  "RIVET_HISTORY_IMPORT_SPACING_MS",
  "RIVET_IDENTITY_OVERRIDE",
  "RIVET_INTERNAL_TOKEN",
  "RIVET_LLM_PRICING_JSON",
  "RIVET_MODEL",
  "RIVET_PING_API_KEY",
  "RIVET_PING_BASE_URL",
  "RIVET_PING_MODEL",
  "RIVET_PROGRAMS_JSON",
  "RIVET_RADAR_CHECK_MIN",
  "RIVET_RATE_LIMIT_MAX",
  "RIVET_REPO_URL",
  "RIVET_REPORT_CHANNEL",
  "RIVET_REQUIRE_GROUNDED_ANSWER",
  "RIVET_RESOLUTION_PIPELINE",
  "RIVET_SESSION_SECRET",
  "RIVET_SLA_CHECK_MIN",
  "RIVET_STAGING_ONLY_CHANNELS",
  "RIVET_TICKET_REACTION",
  "RIVET_TICKET_RESOLVED_REACTION",
  "RIVET_VISION_BASE_URL",
  "RIVET_VISION_MODEL",
  "RIVET_WEB_BASE_URL",
  "RIVET_WEB_HOST",
  "RIVET_WEB_PORT",
  "RIVET_WEB_URL",
  "RIVET_WIZARD_ALLOWLIST",
  "RIVET_WIZARD_CREATOR_ALLOWLIST",
  "RIVET_WIZARD_SUPERADMIN_ALLOWLIST",
  "RIVET_WORKSPACE_ID",
  "SESSION_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_HELP_CHANNEL",
  "VEY_BASE_URL",
  "VEY_CACHE_TTL_MS",
  "VEY_ENABLED",
  "VEY_ENGAGE_THRESHOLD",
  "VEY_TIMEOUT_MS",
  "VISION_API_KEY",
];

const KNOWN_KEYS = new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

function isKnownKey(key) {
  return KNOWN_KEYS.has(key) || /^(?:GROQ|HCAI|OPENCODE)_API_KEY_\d+$/.test(key);
}

function redactedForLog(value) {
  const s = String(value);
  if (s.length === 0) return "<empty>";
  if (s.length <= 8) return `${s.length} chars: ${"*".repeat(s.length)}`;
  return `${s.length} chars: ${s.slice(0, 3)}…${"*".repeat(Math.max(0, s.length - 7))}`;
}

function diff(current, desired) {
  const out = { missing: [], mismatch: [], unexpected: [], extra: [], wouldSet: [] };
  const seen = new Set();
  const allKeys = new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS, ...Object.keys(current), ...Object.keys(desired)]);

  for (const key of allKeys) {
    if (seen.has(key)) continue;
    seen.add(key);

    const have = current[key];
    const want = desired[key];
    const wantIsEmpty = want === undefined || want === null || want === "";
    const haveIsEmpty = have === undefined || have === null || have === "";

    if (wantIsEmpty) {
      if (REQUIRED_KEYS.includes(key) && !haveIsEmpty) out.extra.push(key);
      else if (REQUIRED_KEYS.includes(key) && haveIsEmpty) out.missing.push(key);
      else if (!haveIsEmpty) out.extra.push(key);
      continue;
    }
    if (haveIsEmpty) {
      if (REQUIRED_KEYS.includes(key)) out.missing.push(key);
      else out.wouldSet.push(key);
      continue;
    }
    if (String(have) !== String(want)) out.mismatch.push({ key, have: redactedForLog(have), want: redactedForLog(want) });
  }

  for (const key of Object.keys(desired)) {
    if (!isKnownKey(key)) out.unexpected.push(key);
  }
  return out;
}

module.exports = { MODEL_VARS, SLACK_VARS, REQUIRED_KEYS, OPTIONAL_KEYS, isKnownKey, redactedForLog, diff };
