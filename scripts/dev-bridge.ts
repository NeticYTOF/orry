#!/usr/bin/env bun
// Runs ONLY Core's web server (the /internal/v1 bridge) over a seeded fake
// database, for building a status site locally. No Slack connection, no
// model keys, no corpus, no background loops. Binds 127.0.0.1 only.
//
//   bun run dev:bridge                       fresh temp database, port 4100
//   bun scripts/dev-bridge.ts --port 4111    another port
//   bun scripts/dev-bridge.ts --db ./dev.db  keep the database in a file;
//                                            seeded only if it has no tickets
//   bun scripts/dev-bridge.ts --seed 7       different invented history
//
// Token: RIVET_INTERNAL_TOKEN if set (never printed), else a fixed local dev
// token that is printed. Same for RIVET_INTERNAL_READ_TOKEN. Everything in
// the database is invented (lib/devBridgeSeed.ts).
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const DEV_TOKEN = "dev-bridge-local-token";
const DEV_READ_TOKEN = "dev-bridge-read-token";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || null;
}

const port = Number(arg("--port") || 4100);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("[dev-bridge] --port must be 1-65535");
  process.exit(1);
}
const keepDb = arg("--db");
const seedValue = Number(arg("--seed") || 20261020);

// Bun loads a .env from the working directory on its own. Drop anything that
// could reach Slack or a model provider, so a developer's real keys can never
// be used by this process.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SLACK_") || key.endsWith("_API_KEY") || key.startsWith("JEV_") || key === "DATABASE_URL") {
    delete process.env[key];
  }
}
const tokenFromEnv = Boolean(process.env.RIVET_INTERNAL_TOKEN);
const readFromEnv = Boolean(process.env.RIVET_INTERNAL_READ_TOKEN);
// One temp file per port, replaced on every run, so killed runs leave
// nothing behind to pile up.
const dbPath = keepDb ? path.resolve(keepDb) : path.join(os.tmpdir(), `orry-dev-bridge-${port}.db`);

// Check the port before touching the database: a second copy on the same
// port must not wipe the running one's file.
try {
  Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") }).stop(true);
} catch (_) {
  console.error(`[dev-bridge] 127.0.0.1:${port} is already in use (another dev bridge?). Try --port.`);
  process.exit(1);
}
const people = require("../lib/devBridgePeople");
Object.assign(process.env, {
  RIVET_SKIP_DOTENV: "1",
  RIVET_DB_PATH: dbPath,
  RIVET_INTERNAL_TOKEN: process.env.RIVET_INTERNAL_TOKEN || DEV_TOKEN,
  RIVET_INTERNAL_READ_TOKEN: process.env.RIVET_INTERNAL_READ_TOKEN || DEV_READ_TOKEN,
  RIVET_ADMIN_USER_IDS: people.ORGANIZER_IDS.join(","),
  RIVET_WEB_HOST: "127.0.0.1",
  RIVET_WEB_PORT: String(port),
  JEV_ENABLED: "false",
  VEY_ENABLED: "0",
  RIVET_RESOLUTION_PIPELINE: "false",
});

// A fresh database prints one line per migration; keep the console readable.
const plainLog = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0] === "[rivet/db]" && /^migrated:/.test(String(args[1]))) return;
  plainLog(...args);
};

if (!keepDb) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });

const seed = require("../lib/devBridgeSeed");
process.env.RIVET_PROGRAMS_JSON = JSON.stringify([seed.programConfig()]);
const startedAt = Date.now();
const db = require("../lib/db");
db.open(dbPath);
const summary = seed.seed({ seed: seedValue });
require("../lib/programs").invalidate();

const api = require("../lib/web/api");
api.setSlackClient(seed.fakeSlackClient());
const serve = require("../lib/web/serve");
const server = serve.start();
if (!server) {
  console.error(`[dev-bridge] could not listen on 127.0.0.1:${port}. Is something else using it? Try --port.`);
  process.exit(1);
}

const base = `http://127.0.0.1:${port}`;
const shown = (fromEnv: boolean, value: string) => (fromEnv ? "(from the environment, not shown)" : value);
plainLog(`
[dev-bridge] Orry Core bridge on ${base} (fake data, no Slack) in ${Date.now() - startedAt} ms
  program     ${seed.PROGRAM_ID}   weeks ${summary.weeks[0]} .. ${summary.weeks[summary.weeks.length - 1]}
  tickets     ${summary.tickets} (${summary.finished} finished, ${summary.open} open or parked)
  events      ${summary.events}   audit ${summary.audits}   outbound ${summary.outbound}   outcomes ${summary.outcomes}
  token       ${shown(tokenFromEnv, DEV_TOKEN)}
  read token  ${shown(readFromEnv, DEV_READ_TOKEN)}  (GET routes only)
  database    ${dbPath}${keepDb ? "" : " (deleted on exit)"}

  try: curl -H "Authorization: Bearer ${tokenFromEnv ? "$RIVET_INTERNAL_TOKEN" : DEV_TOKEN}" "${base}/internal/v1/programs/${seed.PROGRAM_ID}/tickets/search?statusGroup=open"
`);

function shutdown() {
  try {
    server.stop(true);
  } catch (_) {}
  try {
    db.close();
  } catch (_) {}
  if (!keepDb) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
