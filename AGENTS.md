# Orry — agent instructions

Read this before touching anything in this repo. It is the whole contract:
how the code is organized, what you may and may not do, and the mistakes
that have already been made here so you do not repeat them.

## What this is

Orry is a Slack help-channel bot (Bun + TypeScript, Socket Mode — it dials
out to Slack, nothing listens inbound). It answers questions from a program's
own documentation corpus, routes what it cannot answer to human helpers, and
learns from resolutions. It currently serves **Loadout**, a Hack Club YSWS.
Live in `#loadout` (main), `#loadout-help` (help/tickets), `#loadout-development`
(report + mentions only).

Two deployables, one direction of coupling:

| Unit | Where | Stack | Authority |
|---|---|---|---|
| **Core** | repo root (`index.ts`, `lib/`) | Bun + TS | All runtime state, one SQLite file |
| **Wizard** | `rivet-wizard/` | Next.js 16 + Postgres | All configuration (separate npm package) |

Wizard never imports Core. It pushes config over Core's `/internal/v1/*`
bridge (`rivet-wizard/lib/rivetCore.ts`, bearer `ORRY_INTERNAL_TOKEN`).

## Commands

```powershell
bun install --frozen-lockfile
bun index.ts --doctor        # preflight; 0 failures before starting
bun index.ts                # run the bot
bun index.ts --ask "<q>" --program loadout   # verify corpus + model, no Slack needed
bun run typecheck            # tsc -p tsconfig.json
bun run format:check         # prettier check
bun run test                 # full core suite (spawned per-file, hermetic)
bun run test:wizard          # wizard suite (same runner, --wizard)
bun run manifest             # Slack app manifest — generated, never hand-written
```

`bun run test` is NOT `bun test`: `scripts/run-tests.mjs` spawns one
`bun test <file>` per file (concurrency 4, hermetic env) so no file's
`mock.module` registrations leak sideways. It kills any file still running
after 120s instead of hanging. `rivet-wizard/package.json` `test` is a bare
single-process `bun test` — **never use it**; process-wide `mock.module`
registrations break `rivetCore*.test.ts` that way. CI runs only the Core
suite plus `test:wizard` via the runner (`test.yml`).

Full verification before any commit: `typecheck` + `format:check` + `test`
+ `test:wizard`. CI enforces the same four.

## Rules

1. **Never commit secrets.** `.env` is gitignored. Before any push or any
   visibility change: `git grep -inE "xox[baprs]-|sk-hc-v1-|gh[pousr]_|sk-[A-Za-z0-9]{20,}|AKIA"`.
   `.env.example` holds placeholders only. `config/` (live channel ids,
   program wiring) is gitignored and **must stay that way**.
2. **Every edit, fix, or refactor must be committed and pushed before yielding.**
   `git -c user.name="aarav" commit`, push `origin main`. Never leave work
   uncommitted.
3. **Correctness first, then six-month maintainability.** Boring design over
   abstraction. No stubs, placeholders, mocks, `TODO: implement`, or fake
   fallbacks. No scope creep while you're in there.
4. **Verify, don't trust.** Non-trivial work ends with a smoke run: run the
   thing, exercise the changed path. Bug fix = reproduce before, confirm
   after. Tests alone are not proof.
5. **Match surrounding code.** CommonJS `require` + `export =` in `lib/`;
   named exports in `lib/web/` and the dashboard. Never reformat a file you
   didn't otherwise change.
6. **User-reported errors are ground truth.** Never re-run checks to confirm
   what the user already told you failed.
7. **NEVER test wiring/copies/forwarding, tautologies, or bare not-throw.**
   New tests only for uncertain edges or user request. Permanent tests must
   catch plausible consumer-visible bugs. A test pinning old wording or
   incidental behavior gets deleted, never re-pinned.
8. **Subagents off by default.** The user explicitly lifts this per-request
   ("use N agents"); that request overrides this rule for that turn.
9. **Large file writes** through `gateway/*` providers: keep each
   write/edit call under ~8 KB; chunk larger files.
10. **No `sed`/`perl`/`python` via bash for individual edits** — use the
    edit tool. `sed -i` for multi-file mechanical renames is fine.

## Where things live

- `index.ts` — entry: `--ask` branch, `--doctor` branch, `startBot()`
- `lib/config.ts` — all env parsing, the ONLY `dotenv.config()` call.
  `ORRY_SKIP_DOTENV=1` opts out (the test harness sets it so `.env`
  cannot leak into test children).
- `lib/handlers.ts` — Slack events: `onMessage`, `onAppMention`, threading
  rule (`thread_ts = event.thread_ts || event.ts`), dedupe via
  `db.claimMessage`. A direct `@`-mention is explicit consent to reply even
  in unclaimed channels.
- `lib/pipeline/engagement.ts` — `classify()` precedence: identity heuristic
  → VEY → JEV → legacy LLM. **The verdict decides, always.**
  `directedAtHuman` is secondary and must never override HELP_NEEDED.
- `lib/intent.ts` — LLM classifier, 3 verdicts. `temperature: 0` (sampling
  turned borderline phrasing into intermittent silence). `MAX_TOKENS`
  default 2000 — must fit the 5-key JSON the parser requires; 20 silently
  broke every classification. `TIMEOUT_MS` env-overridable, default 10s.
- `lib/retrieve.ts` — hand-rolled **BM25** (K1=1.2), no embeddings, no
  vector store. Budgets: `TOTAL_CONTEXT_BUDGET=8000`, `LEARNED_BUDGET=1500`.
- `lib/knowledge.ts` — corpus assembly; `file://` sources resolve under the
  app root; `source_cache` in SQLite; 30-min auto-refresh.
- `lib/answer.ts` — system prompts; `reasoningEffort` forwarded to the
  provider (DeepSeek reasons at full effort otherwise: 15–40s vs 4.4s).
  `ORRY_REQUIRE_GROUNDED_ANSWER` disables streaming + chat replies.
- `lib/lookup.ts` — 4-layer grounding: numeric claims verbatim in corpus,
  same-program evidence, no hedge phrases, `finalAction` matrix.
- `lib/pipeline/messagePolicy.ts` — reply/uncertain/escalate/silence matrix.
  Ungrounded **program** questions → `uncertain` (honest decline out loud).
  Chatter (`kind: general`) → `silence`.
- `lib/tickets.ts` — lifecycle, Slack cards, helper routing
  (`lib/helperRoute.ts`: expertise/load/recency).
- `lib/learn.ts` + `learned_facts` — teach/active-learning store.
- `lib/db.ts` + `lib/schema.ts` — SQLite, WAL, idempotent migrations (120+
  query helpers). Backups via `VACUUM INTO`, never raw copy.
- `lib/llm.ts` — transport: 3 attempts, backoff, 25s timeout, `llm_usage`
  metering. `KNOWN_PRICING` holds measured $/1M (see comment for source).
- `lib/identity.ts` — bot self-description corpus. Program-specific facts
  go in per-program branches of `makerLine`, not generic fallbacks.
- `lib/web/` — Core HTTP: `serve.ts` router, `api.ts` business logic,
  `auth.ts` (`orry_sid` HMAC cookie, 7d). Bridge auth: static bearer
  `ORRY_INTERNAL_TOKEN`, constant-time compare, 404 when unset.
- `lib/veyDecision.ts` + `lib/vey/sidecar.py` — VEY decision client + Python
  sidecar. **Evaluated and rejected as a classifier** (structured lane
  tie-breaks alphabetically on ungrounded input). Kept for cost-routing
  use only; nothing enables it (`VEY_ENABLED=0`).
- `lib/costReport.ts` — daily API cost digest from `llm_usage` rows.
- `loadout/` — the Loadout personalization: `program.json` (drop-in config)
  + `corpus/*.md` (knowledge). `lib/loadoutProgram.test.ts` pins canon.
- `config/` — **gitignored** live deployment (channel ids, program wiring).
- `scripts/` — `doctor.mjs` (preflight), `run-tests.mjs` (harness),
  `manifest.cjs` (manifest source of truth), `autosync.mjs` (one-way
  remote→local sync, `--ff-only`, never pushes), `smoke-test.js`,
  `slack-bootstrap.mjs`, `railway-env-contract.mjs`.

## Loadout canon (the bot's ground truth)

The `jeremy341/loadout` repo is canonical. Currency is **Bolts** (global,
spendable); Track XP is separate, non-spendable, permanent. Four tracks:
**Tools, Systems, Compute, Hardware** — 15 lifetime levels each.
**Research Mode is a modifier, not a track.** Requisitions at
LV.3/6/9/12/15. Custom Order tiers FIELD LV.4, POWER LV.8, ROOT LV.12,
BARE METAL LV.15. AI cap 40%. Quality: Originality / Technical Depth /
Execution / Documentation. Jerry leads; Fazin/Wind and Netic co-organize;
**Netic built Orry**. Program repo `jeremy341/loadout`, bot repo
`NeticYTOF/orry`. Write `Loadout`, `Hack Club`, `YSWS` — never
`LOADOUT`/`Cores`/`yswe`/`YSWSes`. An earlier 5-track/Cores draft is
superseded; `lib/loadoutProgram.test.ts` fails the build if it returns.

## Mistakes already made here (do not repeat)

- `MAX_TOKENS=20` on the classifier truncated the required 5-key JSON →
  every verdict null → silent bot. Verified via the JSON schema, not vibes.
- `directedAtHuman` checked before the verdict → HELP_NEEDED overridden to
  silence, log said `human_conversation` while the classifier was right.
- Classifier judged a thread that already contained the message → read its
  own question as human chatter. `respond.ts` pops the trailing duplicate.
- Temperature 0.3 on a judgement call → intermittent OFF_TOPIC on borderline
  phrasing, silence with no error. Now 0.
- DeepSeek ignores `include_reasoning:false` and reasons anyway (9.5s+
  still truncating at 300 tokens). Budget separation is the only lever.
- `--ask` never resolved a program → always read the empty shared corpus.
  Now `--program <id>`, defaults to the single configured program.
- `helpAnswer`/`pingAnswer` hardwired to 9Router, ignoring `HCAI_*`.
  Routed via `ORRY_ANSWER_*` env instead.
- `.env` re-loaded inside test children by dotenv, defeating the harness's
  env stripping → configured workspace broke 6 suites. `ORRY_SKIP_DOTENV`.
- `--doctor` had no channel-role check → green while the bot crash-looped.
- Validator refused one channel as both help+main; single-channel deploys
  couldn't boot. Help now wins over main (see `programModel.ts`).
- `SLACK_HELP_CHANNEL` treated as required; a normal-only deployment has
  none. Now optional.
- `timeoutFetch` relied solely on abort-event delivery → could hang forever
  (the failure it exists to prevent). Now raced against a deadline.
- `conversations.list` failures uncached → 429 retry loop killed the
  process. Failures cached 60s.
- Tests asserting absence (`config/programs.json` doesn't exist) instead of
  untracked-ness — broke on any real deployment.
- `onAppMention` died on `role: none` — mentions in report-only rooms
  silenced, including the safety path. Mentions now bypass the role gate.
- Bot started with `pty: true` → every crash-loop restart opened a console
  window. Always `pty: false`.
- `run-tests.mjs` runs doctor tests too (`scripts/*.test.ts`); the harness
  collects `lib/` + `scripts/`, wizard separately.

## Deployment

Local (current): `bun index.ts` in `C:\Users\aarav\Projects\Rivet`, supervised
as `orry` (PTY off, restart on-failure), `.env` holds all keys, `config/`
holds channel ids. `autosync` polls every 120s and fast-forwards merged PRs;
it never pushes and refuses on clashing local edits. VPS deploy = clone +
copy `config/programs.json` + provider `.env` values. Bot dies if this
machine sleeps.
