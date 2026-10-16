const { App } = require("@slack/bolt");
const { config, validate, resolveBotUserId } = require("./lib/config");
const knowledge = require("./lib/knowledge");
const handlers = require("./lib/handlers");
const commands = require("./lib/commands");
const respond = require("./lib/respond");
const warm = require("./lib/warm");
const report = require("./lib/report");
const web = require("./lib/web/serve");
const db = require("./lib/db");
const log = require("./lib/log");
const doctor = require("./scripts/doctor.mjs");
const programs = require("./lib/programs");
const { startAfterReady } = require("./lib/startup");

const INITIAL_CORPUS_STARTUP_TIMEOUT_MS = 30_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KEEPALIVE_INTERVAL_MS = 60 * 1000;

function startKeepAlive() {
  return setInterval(() => {
    const key =
      config.zenApiKeys?.[0] ||
      (typeof config.answer.apiKey === "function" ? config.answer.apiKey() : config.answer.apiKey);
    fetch(`${config.answer.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    }).catch((e) => log.debug("keepalive", `ping failed: ${errorText(e)}`));
  }, KEEPALIVE_INTERVAL_MS);
}

async function startBot() {
  validate({ needsSlack: true });
  db.open();
  require("./lib/draftSandbox").loadPersisted();
  try {
    require("./lib/knowledge").loadDraftPersisted();
  } catch (e) {
    log.debug("draft", `draft index rebuild failed: ${errorText(e)}`);
  }
  db.startSweeper();

  const roles = require("./lib/channelPolicy").validate();
  if (!roles.ok) {
    for (const e of roles.errors) log.error("config", `channel role conflict: ${errorText(e)}`);
    throw new Error(`channel role configuration invalid (${roles.errors.length} conflict(s))`);
  }

  try {
    const channelPolicy = require("./lib/channelPolicy");
    const facts = db.assignUnownedLearnedFacts((channel: string | null) => {
      if (!channel) return null;
      const r = channelPolicy.resolve(channel);
      return r.role === "none" ? null : r.program?.id || null;
    });
    if (facts.unowned)
      log.info(
        "knowledge",
        `legacy learned facts: ${facts.assigned} assigned to their channel's program, ${facts.remaining} left unowned (served to no program)`,
      );
  } catch (e) {
    log.warn("knowledge", `legacy learned-fact ownership pass failed: ${errorText(e)}`);
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  app.event("message", handlers.onMessage);
  app.event("app_mention", handlers.onAppMention);
  app.event("reaction_added", handlers.onReactionAdded);
  app.event("reaction_removed", handlers.onReactionRemoved);
  commands.register(app);

  app.error(async (error: Error) => {
    log.error("bolt", error.message);
  });

  let restoredCorpus = { restored: 0, total: 0 };
  try {
    restoredCorpus = knowledge.restoreCorpusFromDisk();
  } catch (e: unknown) {
    log.warn("knowledge", "could not restore cached corpus before startup:", errorText(e));
  }
  const initialCorpusReady = knowledge
    .refreshCorpus()
    .then(() => warm.start())
    .catch((e: unknown) => log.error("knowledge", "initial corpus build failed:", errorText(e)));
  knowledge.startAutoRefresh(config.refreshIntervalMin);
  startKeepAlive();
  report.start(app.client);
  try {
    require("./lib/sla").startSlaLoop(app.client);
  } catch (e) {
    log.error("sla", "loop failed to start:", errorText(e));
  }
  try {
    require("./lib/radar").startRadarLoop();
  } catch (e) {
    log.error("radar", "loop failed to start:", errorText(e));
  }

  const webServer = web.start();
  if (webServer) {
    const api = require("./lib/web/api");
    api.setSlackClient(app.client);
  }

  await startAfterReady(initialCorpusReady, () => app.start(), {
    timeoutMs: INITIAL_CORPUS_STARTUP_TIMEOUT_MS,
    onTimeout: () =>
      log.warn(
        "knowledge",
        `initial corpus refresh exceeded ${INITIAL_CORPUS_STARTUP_TIMEOUT_MS}ms; connecting with ${restoredCorpus.restored}/${restoredCorpus.total} cached sources while refresh continues`,
      ),
  });
  const botUserId = await resolveBotUserId(app.client);
  log.info("bot", `connected via Socket Mode as ${botUserId}`);

  try {
    const channelList = programs.getChannelsList();
    for (const item of channelList) {
      if (item.channelId && item.channelId.startsWith("C")) {
        await app.client.conversations.join({ channel: item.channelId }).catch((e: unknown) => {
          log.debug("bot", `could not auto-join channel ${item.channelId}: ${errorText(e)}`);
        });
      }
    }
  } catch (e) {
    log.debug("bot", `auto-join error: ${errorText(e)}`);
  }
  try {
    require("./lib/resolutionWatcher").start(app.client);
  } catch (e) {
    log.error("resolution", "watcher failed to start:", errorText(e));
  }
  try {
    require("./lib/ticketBackfill").start(app.client);
  } catch (e) {
    log.error("ticketBackfill", "history import failed to start:", errorText(e));
  }
}

async function runAskCli(question: string, programId: string | null): Promise<void> {
  validate({ needsSlack: false });
  db.open();

  // Without a program the lookup resolves the shared corpus, which has no
  // sources — so `--ask` would always decline and could never verify the
  // corpus the bot actually answers from. Default to the only configured
  // program when there is exactly one.
  const program = programId ? programs.get(programId) : singleConfiguredProgram();
  if (programId && !program) {
    console.error(`[rivet] no program with id "${programId}" — check RIVET_PROGRAMS_JSON`);
    process.exit(1);
  }

  await knowledge.refreshCorpus();
  console.log(`[rivet] program: ${program ? program.id : "(shared)"}`);

  const result = await respond.answerOrChat(question, "", {
    program,
    inHelpChannel: Boolean(program),
  });
  if (result?.answer) {
    console.log(`[rivet] source: ${result.source || "(conversational — not in docs)"}`);
    console.log(`[rivet] answer: ${result.answer}`);
    return;
  }

  console.log(`[rivet] would show the fallback: "${respond.MENTION_FALLBACK}"`);
}

function singleConfiguredProgram() {
  const all = programs.all();
  return all.length === 1 ? all[0] : null;
}

function runDoctorCli() {
  const report = doctor.runDoctor();
  console.log(doctor.render(report));
  if (report.failures > 0) {
    console.error("[rivet] fix the FAIL lines above, then start the bot again");
    process.exit(1);
  }
}

function main() {
  process.on("unhandledRejection", (reason) => {
    log.error("process", "unhandled rejection:", reason instanceof Error ? reason.message : reason);
  });

  const askIdx = process.argv.indexOf("--ask");
  if (askIdx !== -1) {
    const question = process.argv[askIdx + 1];
    if (!question) {
      console.error('Usage: bun index.ts --ask "<question>" [--program <id>]');
      process.exit(1);
    }
    const programIdx = process.argv.indexOf("--program");
    const programId = programIdx === -1 ? null : process.argv[programIdx + 1] || null;
    runAskCli(question, programId)
      .then(() => process.exit(0))
      .catch((e) => {
        console.error("[rivet] --ask failed:", errorText(e));
        process.exit(1);
      });
    return;
  }
  const doctorIdx = process.argv.indexOf("--doctor");
  if (doctorIdx !== -1) {
    try {
      runDoctorCli();
    } catch (e) {
      console.error("[rivet] --doctor failed:", errorText(e));
      process.exit(1);
    }
    process.exit(0);
  }

  startBot().catch((e) => {
    console.error(`[rivet] failed to start: ${errorText(e)}`);
    process.exit(1);
  });
}

main();

export {};
