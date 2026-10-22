// Orry preflight: every check the bot makes at boot, run before it is wired
// to Slack, so a setup mistake shows up as one checklist instead of a Slack
// timeout twenty minutes in.
//
//   bun index.ts --doctor        (or: bun scripts/doctor.mjs)
//
// Every check below mirrors a real code path, not a guess at one:
//   required env   -> the shared runtime/deployment contract
//                    (lib/envContract.cjs, consumed by lib/config.ts)
//   program JSON   -> the same two accepted shapes loadEnvPrograms() accepts
//                    (lib/programs.ts), and the config/programs.json fallback
//   file:// source -> resolveLocalPath()'s rules, outside-app-root included
//                    (lib/knowledge.ts)
//   passcode       -> the "rivet" default in the passcode route (lib/web/serve.ts)
//   dev client id  -> the SLACK_CLIENT_ID=dev-testing auto-admin bypass
//                    (lib/web/serve.ts, lib/web/auth.ts)
//
// No check ever prints an env value. Missing values are reported by NAME only:
// a preflight that pastes your bot token into a terminal is a preflight nobody
// pastes into a ticket.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const channelPolicy = require_("../lib/channelPolicy.ts");
const envContract = require_("../lib/envContract.cjs");

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The runtime validator and Railway migration tool import the same contract.
const REQUIRED_VARS = envContract.REQUIRED_KEYS;

// lib/web/serve.ts falls back to this passcode, so "unset" and "rivet" are the
// same weak login.
const DEFAULT_DASHBOARD_PASSCODE = "rivet";

// This value auto-signs an admin session with no login at all.
const DEV_CLIENT_ID = "dev-testing";

// The file fallback loadFilePrograms() reads (lib/programs.ts).
const PROGRAMS_FILE_REL = "config/programs.json";

const PASS = "pass";
const FAIL = "fail";
const WARN = "warn";

const LABEL = { [PASS]: "PASS", [FAIL]: "FAIL", [WARN]: "WARN" };

function result(status, name, detail) {
  return { status, name, detail };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err);
}

function relToRoot(absolute) {
  const rel = path.relative(APP_ROOT, absolute);
  const shown = rel && !rel.startsWith("..") ? rel : absolute;
  return shown.split(path.sep).join("/");
}

/**
 * The two shapes loadEnvPrograms() accepts, and the empty-array case it
 * treats as "no configuration at all".
 */
function programListFrom(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.programs)) return parsed.programs;
  return null;
}

/**
 * resolveLocalPath() in lib/knowledge.ts. Sources are rooted at the app root
 * and anything escaping it is refused there — so a source that resolves
 * outside is a load-time failure, not a slow one.
 */
export function resolveSourcePath(url, appRoot = APP_ROOT) {
  const raw = String(url || "").replace(/^file:\/\//, "");
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(appRoot, raw);
}

function isInsideAppRoot(absolute, appRoot = APP_ROOT) {
  return absolute === appRoot || absolute.startsWith(appRoot + path.sep);
}

export function checkRequiredEnv(env) {
  const missing = REQUIRED_VARS.filter((name) => !String(env[name] || "").trim());
  if (missing.length === 0) {
    return result(PASS, "required env vars", `all ${REQUIRED_VARS.length} set: ${REQUIRED_VARS.join(", ")}`);
  }
  return result(
    FAIL,
    "required env vars",
    `${missing.length} missing: ${missing.join(", ")} — validate() refuses to start until these are set`,
  );
}

export function checkSlackTokenFormats(env) {
  const problems = [];
  const botToken = String(env.SLACK_BOT_TOKEN || "").trim();
  const appToken = String(env.SLACK_APP_TOKEN || "").trim();

  if (botToken && !botToken.startsWith("xoxb-")) {
    problems.push("SLACK_BOT_TOKEN must be the bot OAuth token beginning xoxb-");
  }
  if (appToken && !appToken.startsWith("xapp-")) {
    problems.push("SLACK_APP_TOKEN must be the Socket Mode app-level token beginning xapp-; SLACK_SIGNING_SECRET is not used");
  }

  return problems.length > 0
    ? result(FAIL, "Slack token formats", problems.join("; "))
    : result(PASS, "Slack token formats", "bot and Socket Mode token prefixes look correct");
}

/**
 * Resolves which program config the bot would actually load, with the same
 * precedence and the same tolerance as lib/programs.ts.
 */
export function loadConfiguredPrograms({ env, readFile }) {
  const raw = String(env.ORRY_PROGRAMS_JSON || "").trim();
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { origin: "ORRY_PROGRAMS_JSON", programs: null, error: `not valid JSON (${describeError(err)}) — falling back to config/programs.json` };
    }
    const list = programListFrom(parsed);
    if (!list) {
      return { origin: "ORRY_PROGRAMS_JSON", programs: null, error: "must be an array or { programs: [...] } — falling back to config/programs.json" };
    }
    if (list.length === 0) {
      return { origin: "ORRY_PROGRAMS_JSON", programs: null, error: "is an empty array — treated as no program configured" };
    }
    return { origin: "ORRY_PROGRAMS_JSON", programs: list, error: null };
  }

  const text = readFile(path.join(APP_ROOT, PROGRAMS_FILE_REL));
  if (text === null) return { origin: null, programs: null, error: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { origin: PROGRAMS_FILE_REL, programs: null, error: `not valid JSON (${describeError(err)})` };
  }
  const list = Array.isArray(parsed) ? parsed : null;
  if (!list || list.length === 0) {
    return { origin: PROGRAMS_FILE_REL, programs: null, error: "holds no programs — treated as no program configured" };
  }
  return { origin: PROGRAMS_FILE_REL, programs: list, error: null };
}

export function checkProgramConfig(loaded) {
  if (loaded.error) return result(FAIL, "program config", `ORRY_PROGRAMS_JSON ${loaded.error}`);
  if (!loaded.programs) {
    return result(WARN, "program config", "no program configured — Orry answers generically until one is set");
  }
  return result(PASS, "program config", `${loaded.programs.length} program(s) from ${loaded.origin}`);
}

/**
 * A program with no claimed channels is inert: lib/channelPolicy.resolve()
 * falls back to the shared program with role `none`, so Orry answers
 * nothing anywhere. That is the correct default for safety, and a silent
 * dead end for someone who wired everything else up and waits for a reply.
 */
/**
 * Runs the engine's own channel-role validator. This is the check the bot
 * itself refuses to start on, so --doctor must run it too: without it,
 * --doctor reports a clean config while the process crash-loops on
 * "channel role configuration invalid" seconds later.
 */
export function checkChannelRoles(env = process.env) {
  // lib/channelPolicy.validate() reads process.env directly, so apply the
  // caller's env around the call. Without this the check is untestable and
  // silently reports whatever the developer's own .env happens to say.
  const saved = {};
  const keys = ["SLACK_HELP_CHANNEL", "SLACK_FAQ_CHANNELS"];
  for (const key of keys) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  let roles;
  try {
    roles = channelPolicy.validate();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  if (roles && roles.ok) {
    return result(PASS, "channel roles", "no channel carries a conflicting role");
  }
  const errors = (roles && roles.errors) || [];
  return result(FAIL, "channel roles", `${errors.length} conflict(s): ` + errors.map((e) => `${e.channelId} - ${e.message}`).join("; "));
}

export function checkClaimedChannels(loaded) {
  if (!loaded.programs) return result(PASS, "claimed channels", "no program config to check");
  const idle = loaded.programs.filter((prog) => {
    if (!isRecord(prog)) return false;
    const channels = Array.isArray(prog.channels)
      ? prog.channels.filter((c) => typeof c === "string" && c.trim())
      : [];
    return channels.length === 0 && !(typeof prog.helpChannel === "string" && prog.helpChannel.trim());
  });
  if (idle.length === 0) return result(PASS, "claimed channels", "every program claims at least one channel");
  const ids = idle
    .map((p) => (typeof p.id === "string" && p.id.trim() ? p.id : "(unnamed program)"))
    .join(", ");
  return result(WARN, "claimed channels", `${ids} claims no channels — Orry will answer nothing anywhere. Set "channels": ["C..."] or "helpChannel": "C...".`);
}

export function checkFaqChannelOwnership(loaded, env = process.env) {
  if (loaded.error || !loaded.programs) {
    return result(PASS, "FAQ channel ownership", "no program config to compare with FAQ channels");
  }

  const claimed = new Set();
  for (const prog of loaded.programs) {
    if (!isRecord(prog)) continue;
    for (const channel of Array.isArray(prog.channels) ? prog.channels : []) {
      if (typeof channel === "string" && channel.trim()) claimed.add(channel.trim());
    }
    for (const channel of [
      prog.helpChannel,
      prog.help_channel,
      prog.organizerChannel,
      prog.organizer_channel,
      prog.organizer_channel_id,
    ]) {
      if (typeof channel === "string" && channel.trim()) claimed.add(channel.trim());
    }
  }

  const configured = [
    ...String(env.SLACK_FAQ_CHANNELS || "").split(","),
    env.SLACK_HELP_CHANNEL || "",
  ].map((channel) => channel.trim()).filter(Boolean);
  const unclaimed = [...new Set(configured.filter((channel) => !claimed.has(channel)))];
  if (unclaimed.length === 0) {
    return result(PASS, "FAQ channel ownership", "every configured FAQ/help channel belongs to a program");
  }
  return result(
    WARN,
    "FAQ channel ownership",
    `${unclaimed.join(", ")} is not claimed by a program and will use shared knowledge; add it to that program or confirm shared mode is intentional`,
  );
}

/**
 * Every `file://` source in the loaded config has to point at a file that is
 * still there. A renamed corpus file is otherwise silent: the source is
 * skipped at refresh and the bot simply stops knowing something.
 */
export function checkCorpusFiles(loaded, { fileExists }) {
  if (!loaded.programs) return result(PASS, "corpus files", "no program config to check");

  const refs = [];
  for (const prog of loaded.programs) {
    if (!isRecord(prog)) continue;
    const label = typeof prog.id === "string" && prog.id.trim() ? prog.id : "(unnamed program)";
    if (!Array.isArray(prog.sources)) continue;
    for (const source of prog.sources) {
      if (!isRecord(source) || typeof source.url !== "string" || !source.url.startsWith("file://")) continue;
      refs.push({
        program: label,
        name: typeof source.name === "string" && source.name.trim() ? source.name : source.url,
        url: source.url,
        resolved: resolveSourcePath(source.url),
      });
    }
  }

  if (refs.length === 0) {
    return result(PASS, "corpus files", `no file:// sources among ${loaded.programs.length} program(s) — corpus is remote or inline`);
  }

  const missing = refs.filter((ref) => !isInsideAppRoot(ref.resolved));
  const absent = refs.filter((ref) => isInsideAppRoot(ref.resolved) && !fileExists(ref.resolved));

  if (missing.length === 0 && absent.length === 0) {
    return result(PASS, "corpus files", `all ${refs.length} file:// source(s) present on disk`);
  }

  const lines = [];
  for (const ref of missing) {
    lines.push(`outside the app root, which lib/knowledge.ts refuses to read: ${ref.program} / ${ref.name} -> ${relToRoot(ref.resolved)}`);
  }
  for (const ref of absent) {
    lines.push(`not found: ${ref.program} / ${ref.name} -> ${relToRoot(ref.resolved)}`);
  }
  return result(FAIL, "corpus files", `${lines.length} of ${refs.length} file:// source(s) unusable — ${lines.join("; ")}`);
}

export function checkDashboardPasscode(env) {
  const raw = env.ORRY_DASHBOARD_PASSCODE;
  if (raw === undefined || !String(raw).trim()) {
    return result(
      WARN,
      "dashboard passcode",
      "ORRY_DASHBOARD_PASSCODE is unset, so passcode login is disabled and the console is reachable only through Slack OAuth — set one if you want a way in",
    );
  }
  if (String(raw) === DEFAULT_DASHBOARD_PASSCODE) {
    return result(WARN, "dashboard passcode", "ORRY_DASHBOARD_PASSCODE is the guessable built-in default — anyone who reaches the web port gets in as admin");
  }
  return result(PASS, "dashboard passcode", "set to a custom value");
}

export function checkDevClientId(env) {
  if (env.SLACK_CLIENT_ID !== DEV_CLIENT_ID) {
    if (!env.SLACK_CLIENT_ID) {
      return result(PASS, "slack oauth client id", "unset — the web console has no Slack OAuth login");
    }
    return result(PASS, "slack oauth client id", "set to a real client id");
  }
  if (env.NODE_ENV === "development") {
    return result(
      WARN,
      "slack oauth client id",
      "SLACK_CLIENT_ID is the dev-testing value and NODE_ENV=development, so /login signs you in as admin with no login — fine locally, never on a deployed host",
    );
  }
  return result(
    WARN,
    "slack oauth client id",
    "SLACK_CLIENT_ID is the dev-testing placeholder, which grants nothing without NODE_ENV=development — replace it with your real Slack app's client id",
  );
}

function defaultDeps() {
  return {
    env: process.env,
    fileExists: (target) => fs.existsSync(target),
    readFile: (target) => (fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null),
  };
}

export function runDoctor(deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const loaded = loadConfiguredPrograms(d);

  const checks = [
    checkRequiredEnv(d.env),
    checkSlackTokenFormats(d.env),
    checkProgramConfig(loaded),
    checkClaimedChannels(loaded),
    checkFaqChannelOwnership(loaded, d.env),
    checkChannelRoles(d.env),
    checkCorpusFiles(loaded, d),
    checkDashboardPasscode(d.env),
    checkDevClientId(d.env),
  ];

  return {
    checks,
    passes: checks.filter((c) => c.status === PASS).length,
    failures: checks.filter((c) => c.status === FAIL).length,
    warnings: checks.filter((c) => c.status === WARN).length,
  };
}

export function render(report) {
  const width = report.checks.reduce((max, c) => Math.max(max, LABEL[c.status].length), 0);
  const lines = report.checks.map((check) => {
    const label = LABEL[check.status].padEnd(width);
    return `  ${label}  ${check.name}: ${check.detail}`;
  });

  const parts = [`${report.passes} passed`];
  if (report.warnings > 0) parts.push(`${report.warnings} warning${report.warnings > 1 ? "s" : ""}`);
  parts.push(`${report.failures} failure${report.failures > 1 ? "s" : ""}`);

  const verdict = report.failures > 0 ? "Orry will not start as configured" : "Orry's configuration is loadable";
  return ["Orry doctor — preflight", ...lines, "", `${verdict}: ${parts.join(", ")}`].join("\n");
}

/**
 * @returns {number} process exit code: 1 when any check failed.
 */
export function main() {
  const report = runDoctor();
  console.log(render(report));
  return report.failures > 0 ? 1 : 0;
}
