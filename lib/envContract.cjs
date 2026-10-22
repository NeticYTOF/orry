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
  "ORRY_ADMIN_USER_IDS",
  "ORRY_AMBIENT_UNCERTAIN_REPLY",
  "ORRY_ANSWER_API_KEY",
  "ORRY_ANSWER_BASE_URL",
  "ORRY_BOT_ALIASES",
  "ORRY_BOT_NAME",
  "ORRY_BOT_SLUG",
  "ORRY_CORE_BASE_URL",
  "ORRY_DASHBOARD_PASSCODE",
  "ORRY_DB_PATH",
  "ORRY_DEBUG",
  "ORRY_DEMO_LOGIN",
  "ORRY_DEV_SLACK_ID",
  "ORRY_EMOJI",
  "ORRY_ESCALATE_REACTION",
  "ORRY_FALLBACK_MODEL",
  "ORRY_FEEDBACK_REACTIONS",
  "ORRY_HISTORY_IMPORT_SPACING_MS",
  "ORRY_IDENTITY_OVERRIDE",
  "ORRY_INTERNAL_TOKEN",
  "ORRY_LLM_PRICING_JSON",
  "ORRY_MODEL",
  "ORRY_PING_API_KEY",
  "ORRY_PING_BASE_URL",
  "ORRY_PING_MODEL",
  "ORRY_PROGRAMS_JSON",
  "ORRY_RADAR_CHECK_MIN",
  "ORRY_RATE_LIMIT_MAX",
  "ORRY_REPO_URL",
  "ORRY_REPORT_CHANNEL",
  "ORRY_REQUIRE_GROUNDED_ANSWER",
  "ORRY_RESOLUTION_PIPELINE",
  "ORRY_SESSION_SECRET",
  "ORRY_SLA_CHECK_MIN",
  "ORRY_STAGING_ONLY_CHANNELS",
  "ORRY_TICKET_REACTION",
  "ORRY_TICKET_RESOLVED_REACTION",
  "ORRY_VISION_BASE_URL",
  "ORRY_VISION_MODEL",
  "ORRY_WEB_BASE_URL",
  "ORRY_WEB_PORT",
  "ORRY_WEB_URL",
  "ORRY_WIZARD_ALLOWLIST",
  "ORRY_WIZARD_CREATOR_ALLOWLIST",
  "ORRY_WIZARD_SUPERADMIN_ALLOWLIST",
  "ORRY_WORKSPACE_ID",
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
  const current = key.startsWith("RIVET_") ? "ORRY_" + key.slice(6) : key;
  return KNOWN_KEYS.has(key) || KNOWN_KEYS.has(current) || /^(?:GROQ|HCAI|OPENCODE)_API_KEY_\d+$/.test(key);
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
