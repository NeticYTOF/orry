// Runner for the golden question set in evals/golden/loadout.jsonl.
//
// Without flags it only lists the cases. It calls no model and reads no .env.
//
//   bun scripts/golden-eval.ts                       list cases (offline)
//   bun scripts/golden-eval.ts --live                send each case to the live answer path
//   bun scripts/golden-eval.ts --live --runs 3       send each case 3 times
//   bun scripts/golden-eval.ts --live --out <path>   also write the results as JSON
//
// --live environment:
//   - OPENCODE_API_KEY in a .env file at the repo root. Copy .env.example to
//     .env and fill it in. lib/config.ts validate() refuses to start without
//     this key, so the runner stops early with a message if it is missing.
//     (The ORRY_ fallback key names in lib/config.ts do not pass validate(),
//     so they are not accepted here.)
//   - Network access to the model provider (opencode.ai unless a base URL is
//     set in .env) and to any hosted source the program uses.
//   - Optional: ORRY_DB_PATH. If it is unset the run uses an in-memory
//     database, so it does not write rivet.db. Set it to reuse a database.
//   - Optional: the model overrides listed in .env.example.
//
// The program is loaded from loadout/program.json, which is passed to the
// programs module through ORRY_PROGRAMS_JSON for this run only. The answer call
// is the same one `bun index.ts --ask` makes (lib/lookup.ts answerOrChat).
//
// The lib modules are imported inside runLive(), after .env is loaded, so
// importing this file (for example from the test) reads no config and calls
// no model.

import dotenv from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const goldenPath = join(repoRoot, "evals", "golden", "loadout.jsonl");
const programPath = join(repoRoot, "loadout", "program.json");

export type Verdict = "CASE1" | "CASE2" | "SILENT";

export interface GoldenCase {
  id: string;
  question: string;
  paraphrases?: string[];
  requiredFacts: { text: string; mustAppearIn?: string }[];
  forbiddenClaims?: string[];
  expect: Verdict;
  expectedSource?: string | null;
  note?: string;
}

// The fields of an answer result that the classifier reads.
export interface AnswerLike {
  answer?: string | null;
  source?: string | null;
  unclear?: boolean;
  silent?: boolean;
}

// Classification rules, in order:
//   1. silent flag set                              -> SILENT
//   2. unclear flag, empty text, or text UNCLEAR    -> CASE2
//   3. source missing, empty, or NONE               -> CASE2
//   4. anything else (source and text present)      -> CASE1
export function classifyResult(result: AnswerLike | null | undefined): Verdict {
  if (result?.silent) return "SILENT";
  const text = String(result?.answer ?? "").trim();
  const source = String(result?.source ?? "").trim();
  if (result?.unclear || text === "" || text.toUpperCase() === "UNCLEAR") return "CASE2";
  if (source === "" || source.toUpperCase() === "NONE") return "CASE2";
  return "CASE1";
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function readCases(): GoldenCase[] {
  return readFileSync(goldenPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as GoldenCase);
}

function printOffline(): void {
  for (const c of readCases()) {
    console.log(`${c.id} | ${c.expect} | status: not run (live runner not wired yet)`);
  }
}

interface Options {
  live: boolean;
  runs: number;
  out: string | null;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
  const opts: Options = { live: false, runs: 1, out: null };
  let sawRuns = false;
  let sawOut = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") {
      opts.live = true;
    } else if (arg === "--runs") {
      sawRuns = true;
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new UsageError("--runs needs a whole number, 1 or more");
      opts.runs = n;
    } else if (arg === "--out") {
      sawOut = true;
      const file = argv[++i];
      if (!file) throw new UsageError("--out needs a file path");
      opts.out = resolve(file);
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (!opts.live && (sawRuns || sawOut)) throw new UsageError("--runs and --out only apply with --live");
  return opts;
}

// Each lib module is CommonJS (`export =`), so the object is under `default`.
function pick<T>(mod: unknown): T {
  const m = mod as { default?: unknown };
  return (m.default ?? mod) as T;
}

interface CaseRun {
  run: number;
  got: Verdict | "ERROR";
  source: string | null;
  answer: string;
  requiredOk: boolean;
  forbiddenOk: boolean;
  missingFacts: string[];
  forbiddenHits: string[];
  error?: string;
}

function checkAnswer(c: GoldenCase, answer: string) {
  const haystack = normalise(answer);
  const missingFacts = c.requiredFacts.map((f) => f.text).filter((text) => !haystack.includes(normalise(text)));
  const forbiddenHits = (c.forbiddenClaims ?? [])
    .filter((claim) => normalise(claim) !== "")
    .filter((claim) => haystack.includes(normalise(claim)));
  return { missingFacts, forbiddenHits, requiredOk: missingFacts.length === 0, forbiddenOk: forbiddenHits.length === 0 };
}

async function runLive(opts: Options): Promise<void> {
  dotenv.config({ path: join(repoRoot, ".env") });

  if (!process.env.OPENCODE_API_KEY?.trim()) {
    console.error(
      "golden-eval --live: OPENCODE_API_KEY is not set.\n" +
        "Copy .env.example to .env at the repo root, fill in OPENCODE_API_KEY, then run this again.",
    );
    process.exit(1);
  }

  // Keep the run off the real database unless the user chose one.
  if (!process.env.ORRY_DB_PATH && !process.env.RIVET_DB_PATH) process.env.ORRY_DB_PATH = ":memory:";

  // loadout/program.json is one object. programs.ts reads a JSON array here.
  const programFile = JSON.parse(readFileSync(programPath, "utf8")) as unknown;
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify(Array.isArray(programFile) ? programFile : [programFile]);

  const config = pick<{ validate: (o: { needsSlack: boolean }) => unknown }>(await import("../lib/config"));
  config.validate({ needsSlack: false });

  const db = pick<{ open: () => unknown }>(await import("../lib/db"));
  db.open();

  const programs = pick<{ get: (id: string) => unknown }>(await import("../lib/programs"));
  const program = programs.get("loadout");
  if (!program) {
    console.error('golden-eval --live: program "loadout" was not found in loadout/program.json');
    process.exit(1);
  }

  const knowledge = pick<{ refreshCorpus: () => Promise<unknown> }>(await import("../lib/knowledge"));
  await knowledge.refreshCorpus();

  const lookup = pick<{
    answerOrChat: (question: string, context: string, options: Record<string, unknown>) => Promise<AnswerLike | null>;
  }>(await import("../lib/lookup"));

  const cases = readCases();
  const results: { id: string; question: string; expect: Verdict; runs: CaseRun[] }[] = [];
  console.log(`golden-eval --live: ${cases.length} case(s), ${opts.runs} run(s) each`);
  console.log("id | expect | got | required ok | forbidden ok");

  for (const c of cases) {
    const runs: CaseRun[] = [];
    for (let run = 1; run <= opts.runs; run++) {
      try {
        // skipCache so each run is a fresh model call, not a cached answer.
        const result = await lookup.answerOrChat(c.question, "", {
          program,
          inHelpChannel: true,
          skipCache: true,
        });
        const answer = String(result?.answer ?? "");
        runs.push({
          run,
          got: classifyResult(result),
          source: result?.source ?? null,
          answer,
          ...checkAnswer(c, answer),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runs.push({
          run,
          got: "ERROR",
          source: null,
          answer: "",
          requiredOk: false,
          forbiddenOk: true,
          missingFacts: c.requiredFacts.map((f) => f.text),
          forbiddenHits: [],
          error: message,
        });
      }
    }
    results.push({ id: c.id, question: c.question, expect: c.expect, runs });

    const counts = new Map<string, number>();
    for (const r of runs) counts.set(r.got, (counts.get(r.got) ?? 0) + 1);
    const got =
      counts.size === 1 ? [...counts.keys()][0] : [...counts].map(([v, n]) => `${v}x${n}`).join(",");
    const reqOk = runs.filter((r) => r.requiredOk).length;
    const forbOk = runs.filter((r) => r.forbiddenOk).length;
    const show = (ok: number) => (opts.runs === 1 ? (ok === 1 ? "yes" : "no") : `${ok}/${runs.length}`);
    console.log(`${c.id} | ${c.expect} | ${got} | ${show(reqOk)} | ${show(forbOk)}`);
  }

  const totals: Record<string, number> = { CASE1: 0, CASE2: 0, SILENT: 0, ERROR: 0 };
  let total = 0;
  let matched = 0;
  let requiredMissed = 0;
  let forbiddenMade = 0;
  for (const r of results) {
    for (const run of r.runs) {
      total++;
      totals[run.got] = (totals[run.got] ?? 0) + 1;
      if (run.got === r.expect) matched++;
      if (!run.requiredOk) requiredMissed++;
      if (!run.forbiddenOk) forbiddenMade++;
    }
  }
  console.log("");
  console.log(
    `totals over ${total} run(s): CASE1=${totals.CASE1} CASE2=${totals.CASE2} SILENT=${totals.SILENT} ERROR=${totals.ERROR}`,
  );
  console.log(`expect matched: ${matched} of ${total} run(s)`);
  console.log(`required facts missed in: ${requiredMissed} run(s)`);
  console.log(`forbidden claims made in: ${forbiddenMade} run(s)`);

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      program: "loadout",
      runsPerCase: opts.runs,
      totals,
      cases: results,
    };
    writeFileSync(opts.out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`wrote ${opts.out}`);
  }
}

async function main(argv: string[]): Promise<void> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`golden-eval: ${message}`);
    console.error("usage: bun scripts/golden-eval.ts [--live] [--runs N] [--out <path>]");
    process.exit(2);
  }
  if (!opts.live) {
    printOffline();
    return;
  }
  await runLive(opts);
}

// Runs only when this file is the entry point, not when a test imports it.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`golden-eval: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
