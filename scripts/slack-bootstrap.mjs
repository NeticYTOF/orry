#!/usr/bin/env bun
//
// Guided Slack onboarding: from a fresh clone to a bot that answers in Slack.
//
//   bun scripts/slack-bootstrap.mjs
//
// Three things, and deliberately nothing else:
//
//   1. Writes a .env skeleton with every key validate() requires, all values
//      empty. Refuses to touch an existing .env — a partial one you already
//      filled in is worth more than a "complete" one we would overwrite.
//   2. Prints the Slack app manifest by calling scripts/manifest.cjs, the same
//      module `bun run manifest` prints from. Scopes, events and the twelve
//      slash commands are read from that module, never restated here: they
//      come from ORRY_BOT_SLUG (lib/brand.ts) and lib/commands.ts, and a
//      second copy in a setup script is how the two drift apart.
//   3. Prints the remaining manual steps as plain text.
//
// Never prints, echoes, or writes a secret value — not into .env, not to
// stdout. The required-variable probe runs in an environment stripped of
// secrets. The manifest uses only the non-secret bot name and command slug.
//
// ESM (.mjs) because the engine's other scripts/ files use require() and
// scripts/package.json would otherwise flip the whole directory to ESM.

import { spawnSync } from "node:child_process";
import { existsSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);

// ─── required variables, straight from the code ───────────────────────────────
//
// config.ts's validate() is the only definition of "required" that the engine
// actually enforces. We ask it rather than maintaining a list: spawn the module
// in a child with an environment stripped of everything the parent had, so
// every required variable reads as unset and missingVars() returns the full set.
// Any change to SLACK_VARS/MODEL_VARS shows up here with no edit to this file.

function cleanEnv() {
  const keep = new Set([
    "PATH",
    "Path",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
  ]);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (keep.has(key) && value !== undefined) env[key] = value;
  }
  return env;
}

function requiredVars() {
  const configPath = path.join(ROOT, "lib", "config.ts");
  const probe =
    'const c = require(process.argv[1]); console.error(JSON.stringify(c.missingVars({ needsSlack: true })));';
  // cwd is a temp dir so dotenv.config() (lib/config.ts:10) cannot pick up a
  // .env and satisfy part of the list for us.
  const run = spawnSync("bun", ["-e", probe, configPath], {
    cwd: tmpdir(),
    env: cleanEnv(),
    encoding: "utf8",
  });
  if (run.status !== 0) {
    throw new Error(
      `could not read the required-variable list out of lib/config.ts ` +
        `(bun exited ${run.status ?? "with a signal"}): ${(run.stderr || "").trim() || "no output"}`,
    );
  }
  const line = (run.stderr || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  let names;
  try {
    names = JSON.parse(line || "");
  } catch {
    throw new Error(`lib/config.ts did not return a variable list; got: ${line || "nothing"}`);
  }
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`lib/config.ts reported no required variables, which cannot be right`);
  }
  return names;
}

// ─── what .env.example documents, for each required variable ─────────────────

function exampleNotes() {
  const notes = new Map();
  let file;
  try {
    file = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  } catch {
    return notes;
  }
  let pending = [];
  for (const line of file.split("\n")) {
    const assignment = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (assignment) {
      notes.set(assignment[1], pending);
      pending = [];
      continue;
    }
    const comment = /^#\s?(.*)$/.exec(line);
    const text = comment ? comment[1].trim() : "";
    // A section rule ends the note; a blank line inside a comment block does
    // not, so the prose directly above a key survives intact.
    if (/^─/.test(text)) pending = [];
    else if (text) pending.push(text);
  }
  return notes;
}

// ─── writing .env ────────────────────────────────────────────────────────────
//
// Exclusive create: if the file appeared between the check and the write, the
// open fails with EEXIST and we back off. No read-modify-write window.

function writeEnv(names, notes) {
  const target = path.join(ROOT, ".env");
  if (existsSync(target)) {
    return { written: false, reason: "a .env already exists" };
  }

  const lines = [
    "# Written by scripts/slack-bootstrap.mjs. Every value is empty on purpose —",
    "# fill each one in yourself; this script never handles a secret.",
    "#",
    "# Required keys come from validate() in lib/config.ts. The process refuses",
    "# to start without all of them, naming the ones that are absent.",
    "#",
    "# Optional settings: see .env.example. It documents more than the bot needs",
    "# to run — leave those alone unless you know you want them.",
    "",
  ];
  for (const name of names) {
    const note = notes.get(name);
    if (note && note.length > 0) {
      for (const n of note) lines.push(`# ${n}`);
    } else {
      lines.push(`# (not in .env.example — see lib/config.ts)`);
    }
    lines.push(`${name}=`);
    lines.push("");
  }

  let fd;
  try {
    fd = openSync(target, "wx", 0o600);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return { written: false, reason: "a .env appeared while we were working" };
    }
    throw err;
  }
  try {
    writeSync(fd, lines.join("\n"));
  } finally {
    closeSync(fd);
  }
  return { written: true, reason: null };
}

// ─── output ──────────────────────────────────────────────────────────────────

function section(title) {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

function main() {
  const names = requiredVars();
  const notes = exampleNotes();

  section("Required environment variables");
  console.log(
    `validate() in lib/config.ts requires ${names.length}. The process will not start\n` +
      `until every one of them is set.`,
  );
  for (const name of names) {
    console.log(`  ${name}`);
  }

  section("Writing .env");
  const result = writeEnv(names, notes);
  if (result.written) {
    console.log("Wrote .env with every required key above and an empty value for each.");
    console.log("Open it and fill them in. Do not commit it — it is in .gitignore.");
  } else {
    console.log(`Left .env alone — ${result.reason}.`);
    console.log("Add any missing key above by hand; this script will not overwrite your work.");
  }

  section("Slack app manifest");
  console.log("Paste the JSON below into api.slack.com/apps → Create New App → From a manifest.");
  console.log("Regenerate it with `bun run manifest` after changing ORRY_BOT_NAME or ORRY_BOT_SLUG.\n");
  const { manifest } = require("./manifest.cjs");
  console.log(JSON.stringify(manifest(), null, 2));

  section("Then, by hand");
  const steps = [
    "Create the app from the manifest above, then Install to Workspace.",
    "OAuth & Permissions → copy the Bot User OAuth Token into SLACK_BOT_TOKEN.",
    "Basic Information → App-Level Tokens → generate one with the connections:write",
    "  scope, and put it in SLACK_APP_TOKEN. Socket Mode dials out to Slack, so",
    "  there is no URL to deploy, no domain, and no tunnel.",
    "Put your channel IDs in SLACK_FAQ_CHANNELS — the first entry is the main",
    "  channel. SLACK_HELP_CHANNEL is optional for a dedicated support channel.",
    "Set OPENCODE_API_KEY for the default intent/fallback tiers. HCAI_API_KEY is",
    "  optional; see docs/slack-setup.md for the provider model settings.",
    "Load a program so it has something to answer from: ORRY_PROGRAMS_JSON takes",
    "  the program's JSON inline, not a file path — see docs/slack-setup.md.",
    "Verify without Slack: bun index.ts --ask \"how do I get started\"",
    "Then in Slack: /orry-sources to see what loaded, and /orry <question> for a",
    "  private answer — the question is the whole argument, so type /orry what is",
    "  the deadline rather than /orry ask what is the deadline. The prefix on",
    "  every command is whatever ORRY_BOT_SLUG says; if the app and the process",
    "  disagree, the command silently does nothing.",
    "",
    "Full walkthrough, including the two footguns: docs/slack-setup.md",
  ];
  console.log(steps.join("\n"));
}

try {
  main();
} catch (err) {
  console.error(`slack-bootstrap: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
