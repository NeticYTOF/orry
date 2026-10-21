/* The site's real bridge path against a running Orry Core bridge (normally `bun run dev:bridge` in orry-bot-patched).
   Exercises BridgeSource and every view-model as an organizer and as a helper, prints the headline numbers and any
   typed errors, checks the privacy rules, and exits 1 on a schema mismatch or a privacy failure.

     ORRY_FIXTURES=0 RIVET_CORE_BASE_URL=http://127.0.0.1:4100 RIVET_INTERNAL_READ_TOKEN=dev-bridge-read-token \
       npx tsx scripts/bridge-check.ts [--record test/fixtures/bridge]

   --fixtures runs the same checks over the invented fixtures instead (no bridge needed), to compare the numbers.
   --record <dir> also writes every bridge response it saw to <dir>/responses.json and the headline numbers to
   <dir>/summary.json, for test/data-bridge-contract.test.ts. Only use it against the dev bridge (invented data). */
import fs from "node:fs";
import path from "node:path";
import { BridgeClient } from "../lib/data/bridge/client";
import { BridgeSource } from "../lib/data/bridge/source";
import { FixtureSource } from "../lib/data/fixtures/source";
import { isDataError, type DataSource } from "../lib/data/types";
import { readCaches } from "../lib/data/reads";
import { looksSensitive } from "../lib/data/sensitive";
import { runBridgeChecks, type CheckLog } from "../lib/data/bridge/check";

const argv = process.argv.slice(2);
const recordDir = argv.includes("--record") ? argv[argv.indexOf("--record") + 1] : null;
const fixtures = argv.includes("--fixtures");
const base = process.env.RIVET_CORE_BASE_URL?.replace(/\/+$/, "");

if (!fixtures) {
  if (process.env.ORRY_FIXTURES !== "0") { console.error("Set ORRY_FIXTURES=0 (this script reads the real bridge), or pass --fixtures."); process.exit(2); }
  if (!base) { console.error("Set RIVET_CORE_BASE_URL, for example http://127.0.0.1:4100."); process.exit(2); }
  if (process.env.RIVET_INTERNAL_TOKEN && !process.env.RIVET_INTERNAL_READ_TOKEN) console.warn("Note: only the full token is set. The site should hold the read-only token.");
}

/* Records each response body, keyed the way the replay test looks it up. */
type Recorded = { method: string; path: string; body: string | null; status: number; json: unknown };
const recorded = new Map<string, Recorded>();
const recordingFetch: typeof fetch = async (input, init = {}) => {
  const u = new URL(String(input));
  const res = await fetch(input, init);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? init.body : null;
  recorded.set(`${method} ${u.pathname}${u.search}${body ? ` ${body}` : ""}`, { method, path: u.pathname + u.search, body, status: res.status, json });
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
};

/* The real client, with a higher call budget: this script reads every page at once, the site spreads its reads over
   minutes. The calls it made are printed at the end. */
const client = new BridgeClient({ fetchImpl: recordingFetch, perMinute: 2_000 });
const ds: DataSource = fixtures ? new FixtureSource({ pendingAfterMs: null, state: "live" }) : new BridgeSource(client);

const failures: string[] = [];
const warnings: string[] = [];
const log: CheckLog = {
  line: s => console.log(s),
  fail: s => { failures.push(s); console.log(`  FAIL ${s}`); },
  warn: s => { warnings.push(s); console.log(`  WARN ${s}`); }
};

async function main(): Promise<void> {
  const token = process.env.RIVET_INTERNAL_READ_TOKEN;
  console.log(fixtures ? "Fixture run: the same checks over the invented fixtures (no bridge)\n"
    : `Bridge check against ${base} (${token ? "read-only token" : process.env.RIVET_INTERNAL_TOKEN ? "full token" : "no token"})\n`);
  const result = await runBridgeChecks(ds, log);

  if (!fixtures) {
    console.log("\n== Read-only token and auth");
    if (token) {
      const w = await fetch(`${base}/internal/v1/tickets/1/claim`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ userId: "U0JUNO001" }) });
      const b = await w.json().catch(() => null) as { error?: string } | null;
      log.line(`  POST with the read token: ${w.status} ${JSON.stringify(b)}`);
      if (w.status !== 403) log.fail(`a write with the read-only token answered ${w.status}, expected 403`);
    } else log.warn("no read-only token set, so the write refusal was not checked");
    const bad = await fetch(`${base}/internal/v1/programs/loadout/access?userId=U0PAT0001`, { headers: { authorization: "Bearer wrong-token" } });
    log.line(`  GET with a wrong token: ${bad.status}`);
    if (bad.status !== 401) log.fail(`a wrong token answered ${bad.status}, expected 401`);
  }

  /* privacy: what the caches hold */
  console.log("\n== Privacy: caches");
  const c = readCaches();
  for (const key of c.historyCache.keys()) {
    const h = c.historyCache.peek(key)!.value;
    const leaked = [...h.finished, ...h.created].filter(t => "question" in t || "summary" in t || "resolution" in t);
    if (leaked.length) log.fail(`history cache ${key}: ${leaked.length} rows still carry text fields`);
    else log.line(`  history cache ${key}: ${h.finished.length} finished + ${h.created.length} created rows, no text fields`);
  }
  for (const key of c.detailCache.keys()) {
    const d = c.detailCache.peek(key)!.value;
    for (const e of d?.events ?? []) {
      const s = JSON.stringify(e.detail ?? {});
      if (/"(text|reason|summary|question|body|resolution)"/.test(s)) log.fail(`detail cache ${key}: event ${e.id} detail keeps a text key: ${s}`);
    }
  }
  log.line(`  detail cache: ${c.detailCache.keys().length} tickets, event details text-free`);
  const sensitiveInOpen = (c.openCache.peek(ds.mode)?.value.rows ?? []).filter(r => looksSensitive(r.question)).length;
  log.line(`  open-set cache holds ${sensitiveInOpen} sensitive row(s) in memory only (text dropped after 10 minutes, never sent to a page)`);

  if (!fixtures) {
    console.log("\n== Bridge calls this run (route: calls, failures, p95)");
    for (const [route, s] of Object.entries(client.bridgeStats())) log.line(`  ${route}: ${s.calls} calls, ${s.failures} failures, p95 ${s.p95Ms ?? "-"} ms${s.lastError ? `, last error ${s.lastError}` : ""}`);
  }

  if (recordDir && !fixtures) {
    const dir = path.resolve(recordDir);
    fs.mkdirSync(dir, { recursive: true });
    const responses = [...recorded.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, r]) => ({ key, ...r }));
    // one response per line keeps the file small and its diffs readable
    const head = JSON.stringify({ note: "Recorded from `bun run dev:bridge` (orry-bot-patched) by scripts/bridge-check.ts --record. Invented data only.", recordedAt: result.now });
    fs.writeFileSync(path.join(dir, "responses.json"), `${head.slice(0, -1)},"responses":[\n${responses.map(r => JSON.stringify(r)).join(",\n")}\n]}\n`);
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(result.summary, null, 2) + "\n");
    console.log(`\nRecorded ${responses.length} responses and the summary to ${dir}`);
  }

  console.log(`\n${failures.length ? `FAILED: ${failures.length} problem(s)` : "OK"}${warnings.length ? `, ${warnings.length} warning(s)` : ""}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => {
  console.error(isDataError(e) ? `DataError ${e.kind} on ${e.route ?? "?"}: ${e.message}` : e);
  process.exit(1);
});
