#!/usr/bin/env node
//
// Smoke-test a freshly-deployed orry. Run after `bun run migrate:write`
// has pushed the new env and the new Railway service has had a moment
// to boot. Four checks, in order:
//
//   1. LOGS:    the new service's most recent deploy log contains
//               "connected via Socket Mode" — i.e. the engine actually
//               started and connected to Slack. Fails here means step
//               5 of the checklist didn't get the env right.
//
//   2. ANSWER:  the engine can load a program and sees its sources.
//               Uses the new env loaded from Railway.
//               Fails here means the env contract is missing a key
//               that --ask needs, or the corpus is empty.
//
//   3. WHO:     auth.test against the new SLACK_BOT_TOKEN. Confirms the
//               token is installed in the workspace and returns the
//               right team / bot. Fails here means the tokens didn't
//               copy cleanly or the workspace changed.
//
//   4. GROUNDED: the deployed corpus actually answers. Checks 1-3 all
//               pass on a bot that boots and then declines everything,
//               because nothing has asked it anything yet. This runs the
//               engine's own --ask path (index.ts:152) against the live
//               config and requires a GROUNDED answer — non-empty, from a
//               real source, and not a decline. The question is one the
//               LOADOUT corpus answers (loadout/corpus/02-tracks.md,
//               03-economy.md); deploy a different program and point
//               ORRY_SMOKE_QUESTION at something its docs cover.
//
// Setup:
//
//   RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID
//   in your shell. The script does the rest. Check 4 additionally needs
//   `bun` on PATH and ORRY_PROGRAMS_JSON set on the service; it says so
//   and skips rather than failing when either is missing.
//
// Exits 0 on full pass, non-zero on first failure with a clear message.

const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

// Children need ./lib and ./index.ts, so they run from the repo root rather
// than from wherever this file was invoked.
const REPO_ROOT = path.join(__dirname, "..");

// Checked against the deployed corpus, so a source list that loaded but has
// nothing about the currency is a real failure, not a pass.
const SMOKE_QUESTION = (process.env.ORRY_SMOKE_QUESTION ?? process.env.RIVET_SMOKE_QUESTION) || "what is the program's currency?";

// The bot's own "I won't guess" replies, all of which mean it did not answer.
// lib/respond.ts:97-99 are the canned fallbacks, lib/respond.ts:452-457 is
// uncertaintyText, and the remaining entries are the phrases
// isGroundedAnswer rejects inside an otherwise well-formed answer body
// (lib/respond.ts:152-165). index.ts:144 prints the MENTION_FALLBACK line
// instead of an answer when --ask finds nothing.
const DECLINE_MARKERS = [
  /would show the fallback/i,
  /\bhmm not totally sure\b/i,
  /\bnot sure\b/i,
  /\bdon'?t know\b/i,
  /\bdo not know\b/i,
  /\bcouldn'?t verify\b/i,
  /\bno confirmed\b/i,
  /\bhaven'?t confirmed\b/i,
  /\bhasn'?t confirmed\b/i,
  /\bno official\b/i,
  /\bask (?:in|a helper|an organizer)\b/i,
  /\bsuggest asking\b/i,
  /\bcheck (?:with|in|the site)\b/i,
  /\bhaving trouble\b/i,
  /\bwoah slow down\b/i,
];

function capture(bin, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}


function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`error: ${name} is not set`);
    process.exit(2);
  }
  return v;
}

async function callRailway(query, variables = {}) {
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("RAILWAY_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(`railway api: ${body.errors[0].message}`);
  return body.data;
}

async function fetchVars() {
  const data = await callRailway(
    `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
       variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
     }`,
    {
      projectId: required("RAILWAY_PROJECT_ID"),
      environmentId: required("RAILWAY_ENVIRONMENT_ID"),
      serviceId: required("RAILWAY_SERVICE_ID"),
    },
  );
  return data.variables || {};
}

// Pull the most recent deployment's log content. Railway's logs come back as
// a stream of lines; we just want the last few hundred to scan for the
// success line.
async function fetchRecentLogs() {
  const data = await callRailway(
    `query($deploymentId: String!, $limit: Int!) {
       deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
         timestamp
         message
       }
     }`,
    {
      deploymentId: required("RAILWAY_DEPLOYMENT_ID"),
      limit: 500,
    },
  );
  return (data.deploymentLogs || []).map((l) => l.message);
}

async function latestDeploymentId() {
  const data = await callRailway(
    `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
       deployments(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, first: 1) {
         edges { node { id status } }
       }
     }`,
    {
      projectId: required("RAILWAY_PROJECT_ID"),
      environmentId: required("RAILWAY_ENVIRONMENT_ID"),
      serviceId: required("RAILWAY_SERVICE_ID"),
    },
  );
  const edge = data.deployments?.edges?.[0];
  if (!edge) throw new Error("no deployments found for this service");
  return edge.node;
}

async function checkLogs() {
  console.log("[1/4] checking deployment logs for engine startup…");

  // The user can pre-set RAILWAY_DEPLOYMENT_ID to point at a specific deploy
  // (useful for re-running), but the common case is "the latest one".
  if (!process.env.RAILWAY_DEPLOYMENT_ID) {
    const dep = await latestDeploymentId();
    console.log(`     latest deployment: ${dep.id} (${dep.status})`);
    if (dep.status === "FAILED" || dep.status === "CRASHED") {
      console.error(`FAIL: latest deployment is ${dep.status}. read the logs in the Railway dashboard.`);
      process.exit(1);
    }
    process.env.RAILWAY_DEPLOYMENT_ID = dep.id;
  }

  const lines = await fetchRecentLogs();
  const connected = lines.some((l) => /connected via Socket Mode as U/.test(l));
  const missingEnv = lines.some((l) => /missing required environment variable/.test(l));
  const crashed = lines.some((l) => /(panic|Error:|TypeError:|Cannot read)/i.test(l));

  if (missingEnv) {
    console.error("FAIL: engine started, then refused to start — missing required env.");
    console.error("  run: bun run migrate:check, fill in what's missing, then deploy again.");
    process.exit(1);
  }
  if (crashed) {
    console.error("FAIL: crash trace in deployment logs. read them in the dashboard.");
    process.exit(1);
  }
  if (!connected) {
    console.error("FAIL: no 'connected via Socket Mode' line in the last 500 log lines.");
    console.error("  the service is up but didn't finish starting. wait a minute and re-run, or check logs.");
    process.exit(1);
  }
  console.log("     ok: engine started and bound to slack socket mode");
}

function runAsk(question, env) {
  return new Promise((resolve, reject) => {
    // We can't actually call the engine's --ask from here (it needs the
    // engine installed and a corpus built). What we CAN do is run a small
    // node script that uses the same env to:
    //   1. resolve the question through the engine's intent classifier
    //   2. confirm ORRY_PROGRAMS_JSON parses and the program is loadable
    // These are the things a Slack reply depends on, and they're the things
    // that quietly break when env vars are partial.
    const script = `
      const programs = require("./lib/programs");
      const all = programs.all();
      if (all.length === 0) {
        console.error("NO_PROGRAMS");
        process.exit(2);
      }
      const p = all[0];
      const sources = require("./lib/knowledge").loadSources();
      console.log("PROGRAM=" + p.id);
      console.log("SOURCES=" + sources.length);
      console.log("HAS_ANSWER_KEY=" + (process.env.HCAI_API_KEY ? "yes" : "no"));
    `;
    const child = spawn("node", ["-e", script], {
      env: { ...process.env, ...env },
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function checkAnswer() {
  console.log("[2/4] checking the engine can resolve a question…");
  const vars = await fetchVars();
  const { code, out, err } = await runAsk("how do i submit my project", vars);
  if (code !== 0) {
    console.error("FAIL: engine refused to load with the new env.");
    console.error("  exit code:", code);
    console.error("  stderr:", err.slice(-500));
    process.exit(1);
  }
  const programLine = out.split("\n").find((l) => l.startsWith("PROGRAM="));
  const sourceLine = out.split("\n").find((l) => l.startsWith("SOURCES="));
  const keyLine = out.split("\n").find((l) => l.startsWith("HAS_ANSWER_KEY="));

  if (!programLine) {
    console.error("FAIL: engine started but no program loaded — ORRY_PROGRAMS_JSON may be malformed.");
    process.exit(1);
  }
  if (sourceLine && Number(sourceLine.split("=")[1]) === 0) {
    console.error("WARN: no sources loaded. ORRY_PROGRAMS_JSON might be missing or empty.");
    // Not a hard fail — a bot can still answer with a knowledge gap
  }
  if (keyLine && keyLine.split("=")[1] === "no") {
    console.error("FAIL: HCAI_API_KEY is not set on the new project.");
    process.exit(1);
  }
  console.log("     ok:", programLine, "|", keyLine, "|", sourceLine);
}

// Loads the deployed program through lib/programs and reads its corpus
// through lib/knowledge — the same two modules index.ts:132 pulls in before
// it answers anything. Reports what loaded so the caller can tell "no sources
// configured" from "sources configured but unreadable".
const SOURCE_PROBE = `
  const programs = require("./lib/programs");
  const knowledge = require("./lib/knowledge");
  const id = (process.env.ORRY_SMOKE_PROGRAM ?? process.env.RIVET_SMOKE_PROGRAM);
  const prog = programs.get(id);
  if (!prog) {
    console.log("PROGRAM_MISSING=1");
    process.exit(0);
  }
  const configured = (prog.sources || []).length;
  if (configured === 0) {
    console.log("PROGRAM=" + prog.id);
    console.log("CONFIGURED_SOURCES=0");
    process.exit(0);
  }
  await knowledge.refreshCorpus();
  const rows = knowledge.sourceStatus(id);
  const loaded = rows.filter((r) => r.status === "ready" || r.status === "stale");
  const unloaded = rows.filter((r) => r.status !== "ready" && r.status !== "stale");
  console.log("PROGRAM=" + prog.id);
  console.log("CONFIGURED_SOURCES=" + configured);
  console.log("LOADED_SOURCES=" + loaded.length);
  console.log("UNLOADED=" + unloaded.map((r) => r.name + " (" + r.status + ")").join("; "));
  console.log("CORPUS_CHARS=" + knowledge.getCorpus(id).length);
`;

// Reuses the engine's own definition of grounded rather than a second copy of
// it — if lib/respond.ts tightens what counts as an answer, this check
// tightens with it. The source arrives empty when index.ts:139 had none to
// report, which isGroundedAnswer rejects outright (lib/respond.ts:143).
const GROUNDED_PROBE = `
  const respond = require("./lib/respond");
  const grounded = respond.isGroundedAnswer({
    source: (process.env.ORRY_SMOKE_SOURCE ?? process.env.RIVET_SMOKE_SOURCE),
    answer: (process.env.ORRY_SMOKE_ANSWER ?? process.env.RIVET_SMOKE_ANSWER),
  });
  console.log("GROUNDED=" + (grounded ? "yes" : "no"));
`;

function smokeEnv(vars) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orry-smoke-"));
  // A throwaway database so the check reads the deployed config and nothing
  // else: no local answer cache to hit, no local program rows to shadow the
  // env. It also means this never writes to the repo's rivet.db.
  const env = { ...process.env, ...vars, ORRY_DB_PATH: path.join(dir, "rivet.db") };
  return { dir, env };
}

// Value of a `KEY=value` line the probes print.
function lineValue(out, prefix) {
  const line = out.split("\n").find((l) => l.trim().startsWith(prefix));
  return line ? line.slice(line.indexOf("=") + 1).trim() : null;
}

// The source name on the first line after its label. index.ts:139 prints it
// inline, and a source name is never multiline.
function afterLabelLine(out, prefix) {
  const at = out.indexOf(prefix);
  if (at === -1) return null;
  const rest = out.slice(at + prefix.length);
  const nl = rest.indexOf("\n");
  return (nl === -1 ? rest : rest.slice(0, nl)).trim();
}

// Everything after the answer label. An answer may itself contain newlines
// (index.ts:140 prints result.answer verbatim), so this takes the remainder
// rather than only the first line.
function afterLabelRest(out, prefix) {
  const at = out.indexOf(prefix);
  return at === -1 ? null : out.slice(at + prefix.length).trim();
}

async function checkGrounded() {
  console.log("[4/4] proving the bot answers from the deployed corpus…");

  try {
    await capture("bun", ["--version"], process.env);
  } catch (_err) {
    console.log("     SKIP: `bun` is not on PATH.");
    console.log("     this check runs the engine's own --ask path (index.ts:152), which needs bun.");
    console.log("     install bun (https://bun.sh) and re-run, or run checks 1-3 by hand.");
    return;
  }

  const vars = await fetchVars();
  const raw = (vars.ORRY_PROGRAMS_JSON || "").trim();
  if (!raw) {
    console.log("     SKIP: ORRY_PROGRAMS_JSON is not set on this service.");
    console.log("     nothing is configured for the bot to answer from. See deploy/slack/README.md.");
    return;
  }

  let configured;
  try {
    const parsed = JSON.parse(raw);
    configured = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.programs) ? parsed.programs : null;
  } catch (err) {
    console.error(`FAIL: ORRY_PROGRAMS_JSON on the service is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!configured) {
    console.error("FAIL: ORRY_PROGRAMS_JSON on the service is neither an array nor { programs: [...] }.");
    process.exit(1);
  }

  const wanted = (process.env.ORRY_SMOKE_PROGRAM ?? process.env.RIVET_SMOKE_PROGRAM);
  const program =
    (wanted && configured.find((p) => p && p.id === wanted)) ||
    configured.find((p) => p && Array.isArray(p.sources) && p.sources.length > 0);
  if (!program) {
    console.log("     SKIP: no configured program declares any sources.");
    console.log("     set ORRY_PROGRAMS_JSON with a sources array. See deploy/slack/README.md.");
    return;
  }
  if (!Array.isArray(program.sources) || program.sources.length === 0) {
    console.log(`     SKIP: program "${program.id}" declares no sources, so there is no corpus to answer from.`);
    return;
  }

  const { dir, env } = smokeEnv(vars);
  try {
    const probeEnv = { ...env, ORRY_SMOKE_PROGRAM: program.id };
    const probe = await capture("bun", ["-e", SOURCE_PROBE], probeEnv);
    if (probe.code !== 0) {
      console.error("FAIL: the engine could not load the deployed program.");
      console.error("  exit code:", probe.code);
      console.error("  stderr:", probe.err.slice(-500));
      process.exit(1);
    }
    if (lineValue(probe.out, "PROGRAM_MISSING") === "1") {
      console.error(`FAIL: program "${program.id}" is in ORRY_PROGRAMS_JSON but did not load.`);
      process.exit(1);
    }
    const loaded = Number(lineValue(probe.out, "LOADED_SOURCES") || 0);
    const configuredCount = Number(lineValue(probe.out, "CONFIGURED_SOURCES") || 0);
    if (configuredCount === 0 || loaded === 0) {
      console.error(`FAIL: program "${program.id}" declares ${configuredCount} source(s) and loaded none of them.`);
      console.error("  check the source urls in ORRY_PROGRAMS_JSON and any volume-mounted files they point at.");
      process.exit(1);
    }
    const unloaded = lineValue(probe.out, "UNLOADED");
    console.log(`     ok: ${loaded}/${configuredCount} sources loaded into the corpus`);
    if (unloaded) console.log(`     note: not usable — ${unloaded}`);

    // `bun index.ts --ask --program <id>` scopes the lookup to the same
    // program a Slack message in that channel resolves to, so this check
    // exercises the deployed corpus itself rather than a rewritten copy of it.
    const ask = await capture("bun", ["index.ts", "--ask", SMOKE_QUESTION, "--program", program.id], env);
    if (ask.code !== 0) {
      console.error("FAIL: `bun index.ts --ask` failed against the deployed config.");
      console.error("  exit code:", ask.code);
      console.error("  stderr:", ask.err.slice(-500));
      process.exit(1);
    }

    const rawSource = afterLabelLine(ask.out, "[orry] source:");
    const answer = afterLabelRest(ask.out, "[orry] answer:");
    if (rawSource === null || answer === null) {
      // index.ts:144 prints the fallback instead of an answer when --ask
      // found nothing grounded — the clearest decline signal there is.
      if (/would show the fallback/.test(ask.out)) {
        console.error(`FAIL: the bot declined "${SMOKE_QUESTION}" — it had nothing grounded to say.`);
        console.error("  the corpus covers this question — fix the sources in ORRY_PROGRAMS_JSON, then re-run.");
        process.exit(1);
      }
      console.error(`FAIL: --ask printed no answer for "${SMOKE_QUESTION}".`);
      console.error("  stdout:", ask.out.trim().slice(-500) || "(empty)");
      process.exit(1);
    }

    const declines = DECLINE_MARKERS.filter((re) => re.test(answer)).map((re) => String(re));
    const grounded = await capture("bun", ["-e", GROUNDED_PROBE], {
      ...env,
      ORRY_SMOKE_SOURCE: rawSource === "(conversational — not in docs)" ? "" : rawSource,
      ORRY_SMOKE_ANSWER: answer,
    });
    if (grounded.code !== 0) {
      console.error("FAIL: could not evaluate the answer with lib/respond.isGroundedAnswer.");
      console.error("  stderr:", grounded.err.slice(-500));
      process.exit(1);
    }

    if (declines.length > 0 || lineValue(grounded.out, "GROUNDED") !== "yes") {
      console.error(`FAIL: the bot declined "${SMOKE_QUESTION}" — the deployed corpus does not answer it.`);
      console.error(`  answer: ${answer.slice(0, 300)}`);
      if (rawSource) console.error(`  source: ${rawSource}`);
      if (declines.length > 0) console.error(`  matched the bot's own decline wording: ${declines.join(", ")}`);
      console.error("  the corpus covers this question — fix the sources in ORRY_PROGRAMS_JSON, then re-run.");
      process.exit(1);
    }

    console.log(`     ok: grounded answer from "${rawSource}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
   }
}

async function checkWho() {
  console.log("[3/4] checking the bot's Slack install (auth.test)…");
  const vars = await fetchVars();
  const token = vars.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("FAIL: SLACK_BOT_TOKEN is not set on the new project.");
    process.exit(1);
  }
  if (!token.startsWith("xoxb-")) {
    console.error("FAIL: SLACK_BOT_TOKEN doesn't start with xoxb- — copy the bot user token, not the app-level one.");
    process.exit(1);
  }

  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`FAIL: auth.test: ${data.error}`);
    process.exit(1);
  }
  console.log(`     ok: bot user ${data.user_id} in team ${data.team} (${data.team_id})`);
}

async function main() {
  await checkLogs();
  await checkAnswer();
  await checkWho();
  await checkGrounded();
  console.log("\nsmoke test passed. ready to cut over.");
  console.log("next: pause the old service, watch the new one for a few hours, then delete the old one.");
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
