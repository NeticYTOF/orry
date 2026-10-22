# Orry — Architecture

Orry answers help-channel questions in Slack from a program's own documentation,
routes what it can't answer to human helpers, and learns from the resolutions.

Two deployables, one direction of coupling:

| Unit | Where | Stack | Authority |
|---|---|---|---|
| **Core** | repo root (`index.ts`, `lib/`) | Bun + TypeScript, Socket Mode | **All runtime state.** SQLite (`bun:sqlite`, `lib/db.ts`) |
| **Wizard** | `rivet-wizard/` | Next.js 16 + Postgres | **All configuration.** Program rows, channel claims, helper roster, entitlements |

Wizard never imports Core. It pushes config over Core's `/internal/v1/*` HTTP
bridge (`rivet-wizard/lib/rivetCore.ts`, bearer `ORRY_INTERNAL_TOKEN`) and tracks
delivery in `core_sync_state`; a daily cron (`0 9 * * *`) re-sends anything not `synced`.

## Request lifecycle (a question in a help channel)

1. **Receive** — `index.ts:69-70` registers `app.event("message")` and
   `app.event("app_mention")` on one Bolt `App` in Socket Mode. `commands.register(app)`
   (`index.ts:73`) adds 12 slash commands, block actions, a modal, a shortcut and App Home.
2. **Deliver / dedupe** — `lib/handlers.ts:onMessage` rejects bot-authored and loopback
   messages, then `db.claimMessage()` (`lib/db.ts:305`) does an atomic
   `INSERT OR IGNORE` into `answered_messages` (24h TTL) so `message` + `app_mention`
   double delivery answers once.
3. **Thread rule** — `const threadTs = event.thread_ts || event.ts` (`handlers.ts:887`).
   Every reply carries `thread_ts`; only DM posts top-level.
4. **Resolve tenant** — `lib/workspace.ts` maps the event to a workspace id (team id, else
   `ORRY_WORKSPACE_ID`), `lib/programs.ts:340` resolves channel → program through the
   `program_channels` claim table whose composite primary key
   `(workspace_id, channel_id)` (`lib/schema.ts:256`) enforces one owner per channel.
5. **Channel role** — `lib/channelPolicy.ts:35` resolves DM > help > organizer > main and
   forces ambient replies / tickets / helper escalation **off** in an organizer channel.
6. **Should we speak?** — `lib/eligibility.ts:271` `shouldOrryRespond` is a deterministic
   regex gate returning `reply | silent | escalate | human_defer`. It terminates mute,
   human takeover, greetings, acknowledgement, thread chatter, referential mentions, and
   sensitive-topic hits.
7. **Is this for us?** — `lib/pipeline/engagement.ts:104` classifies: identity/smalltalk
   regex → optional JEV model (7 intents, `lib/jevDecision.ts:142`) → `lib/intent.ts`
   LLM classifier (3 verdicts: `HELP_NEEDED | CASUAL_CHAT | OFF_TOPIC`).
   `lib/pipeline/messagePolicy.ts:41` maps `(role, addressed, intent)` → proceed or silence.
8. **Retrieve** — `lib/knowledge.ts` assembles the corpus, `lib/retrieve.ts` scores it with
   hand-rolled **BM25** (K1=1.2, B=0.75). There is no embedding model and no vector store.
   Corpus = per-source fetched text cached in SQLite `source_cache`, plus generated
   sections (identity "About orry", program timeline, approved learned facts).
9. **Answer** — `lib/lookup.ts:242` → `lib/answer.ts:210` `systemPrompt`, through
   `lib/llm.ts` (blocking or SSE streaming, 3 attempts, exponential backoff, 25s timeout,
   every call metered into `llm_usage`).
10. **Grounding gate (4 layers)** — `lookup.exactClaimAllowed` (every number must appear
    verbatim in the corpus; authoritative-only topics forbidden) → `grounding.validateClaimSupport`
    (recomputes support from same-program evidence) → `respond.isGroundedAnswer` (source ≠
    `NONE`, no hedge phrases, no `UNCLEAR`) → `messagePolicy.finalAction` returns
    `reply | uncertain | escalate | escalate_and_uncertain | escalate_and_reply_chat | silence`.
    `ORRY_REQUIRE_GROUNDED_ANSWER` additionally disables streaming and chat replies.
11. **Escalate** — `lib/tickets.ts` `ensureSupportTicket` files a ticket from the thread,
    `lib/helperRoute.ts` ranks helpers (expertise match, load, recency, ping fatigue),
    `lib/assignmentLifecycle.ts` tracks offer/claim/decline/release/timeout epochs.
12. **Close the loop** — `lib/resolutionWatcher.ts` auto-resolves when a helper's reply
    satisfies the questioner; `lib/activeLearning.ts` + `lib/learn.ts` extract the fact into
    `learned_facts`, which busts the answer cache and knowledge index so it is effective in
    the same turn. Unanswered questions land in `doc_gaps`; `lib/gapClusters.ts` clusters
    them and offers FAQ proposals.

## Knowledge

- **Storage** — SQLite `source_cache` keyed by `name::url`, plus an in-process Map.
  Chunks are 100–900 chars, markdown-heading aware (`lib/retrieve.ts:309`).
- **Ingest** — per-source text fetch (inline / `file://` / json-faq / gdoc / github-dir /
  url crawl, optionally via Firecrawl `lib/firecrawl.ts`), capped at 200k chars, SSRF-guarded
  (`lib/sourceGuard.ts` resolves DNS and rejects private ranges per redirect).
- **Freshness** — hourly `setInterval` full refresh, a startup refresh, an admin
  `/api/knowledge/refresh`, and a fire-and-forget per-program refresh from Wizard.
  Failures increment `fail_count` and downgrade source status, which then gates whether
  exact factual claims from that source are allowed.
- **Budgets** — `TOTAL_CONTEXT_BUDGET=8000`, `LEARNED_BUDGET=1500`, `LEARNED_MAX_FACTS=5`
  (`lib/retrieve.ts:71-73`).

## Learning

One table, `learned_facts`. Four producers: active learning from resolved tickets, the
`teach` command, the teach-thread shortcut, and gap-cluster FAQ proposals. Two readers:
`lib/learn.ts` renders it as the "Learned answers" prompt section, and `lib/gapClusters.ts`
uses it for coverage checks. Supersession is explicit (`superseded_by`, `superseded_at`).

`lib/teachThread.ts` is a read-only summarizer — it renders the thread transcript and asks
the answer model for exactly one `question :: answer` line; it never writes. The write goes
through `/orry-teach` → `learn.captureFromThread`, pending unless auto-approve is on.

## Identity and permissions

Three checks, layered:

1. **Wizard browser session** — HMAC cookie `rivet_wizard_session` from Hack Club Auth OAuth,
   carrying `hcaId`/`email`/`slackId`; allowlists plus per-program relationship
   (owner → admin → helper → public) in `rivet-wizard/lib/programAccess.ts`.
2. **Core bridge** — single static bearer `ORRY_INTERNAL_TOKEN`, constant-time compare;
   404 when unset (`lib/web/api.ts:818`).
3. **Core re-check** — every program-scoped bridge call re-verifies `actorId` with
   `tickets.isActorAllowed` (`isAdmin || db.isHelper`). A forged or stale Wizard session
   cannot mutate Core outside the helper roster.

Roles resolve via `lib/commandRegistry.ts:253` `authorize()` — `config.isAdmin`
(env allowlist `ORRY_ADMIN_USER_IDS`) or the per-program roster.

## Analytics

Core computes every dashboard number from its own SQLite and serves it over the bridge;
Wizard is a pure view layer (`rivet-wizard/lib/dashboardMetrics.ts` only folds snapshots).
`lib/supportAnalytics.ts` produces the overview (deflection rate, reopen rate, duplicate
rate, medians, helper load, stale-48h, gap counts). `lib/programHealth.ts` folds it into a
four-component 0-100 score. **Nothing in the metrics path is cached** — the only TTLs in the
system are the answer cache (`lib/cache.ts`, 6h freshness for volatile sources, 7d idle
sweep) and a 45s `unstable_cache` for the Slack channel list.

## Data layer

- **Core** — one embedded SQLite file. `lib/schema.ts` holds 19 base tables, ~110 ordered
  migrations and 36 post-migration indexes, applied idempotently on every open under
  `PRAGMA journal_mode=WAL`, `busy_timeout=5000`. `lib/db.ts` exports 120+ query helpers and
  is the authoritative owner of every ticket state transition.
- **Wizard** — Postgres. `rivet-wizard/db/schema.sql` plus numbered migrations applied by
  `rivet-wizard/scripts/migrate.mjs` in one transaction, tracked in `wizard_schema_migrations`.
- Backups must use `VACUUM INTO` under WAL, never a raw file copy (`docs/deployment.md`).

## Vision

Images attached to a mention are downloaded from Slack with the bot token, base64'd into a
data URI and sent to a vision model (500 max tokens, 30s) with a system prompt carrying a
`SKIP` sentinel. Bytes live only for the request; only the text placeholder
`[uploaded image] <question>` enters thread context. DM images are rate-limited
(8/min) *before* any vision call.

## Deployment

| Target | Unit | Build | Start | Port | Storage |
|---|---|---|---|---|---|
| Railway `rivet` | Core | Docker, `oven/bun:1` | `bun index.ts` | 4100 | `/data` volume |
| Railway/Vercel | Wizard | RAILPACK / Next auto | `next start -p 4901` | 4901 | Postgres |
| Railway (private net) | 9router | `node:22-slim`, `9router@0.5.40` | `9router --host ::` | 20128 | `/data` |
| systemd --user | Core | — | `bun index.ts` | 4100 | local |

No `EXPOSE` and no healthcheck on Core: Socket Mode means no public port is required.
`deploy/rivet.service` caps crash loops (`StartLimitBurst=5`) so a missing-env failure
surfaces as a failed unit instead of a 5s restart storm.

## Testing

Two suites, deliberately different runners.

- **Core** — 83 files under `lib/`. `bun run test` is **not** `bun test`: it runs
  `scripts/run-tests.mjs`, which spawns one `bun test <file>` process per file
  (concurrency 4, hermetic env) so no file's `mock.module` registrations or DB rows leak
  sideways. `lib/test-setup.ts` pins `ORRY_DB_PATH=":memory:"` via `bunfig.toml` preload.
- **Wizard** — 19 files, `bun:test`, Postgres replaced by pg-mem, Core HTTP faked by
  `globalThis.fetch` mocks or `mock.module("@/lib/rivetCore", …)`.
  **Known issue:** `rivet-wizard/package.json` sets `"test": "bun test"` — a bare
  single-process run. Because `mock.module("@/lib/rivetCore", …)` is process-wide,
  `rivetCoreUsage.test.ts`, `rivetCoreDashboard.test.ts` and `rivetCoreErrors.test.ts` fail
  with `Export named 'coreUsage' not found` when run that way. `bun run test:wizard`
  (`run-tests.mjs --wizard`) is the isolation workaround and passes.
- **CI** (`.github/workflows/test.yml`) runs only Core: `bun install --frozen-lockfile` →
  `typecheck` → `format:check` → `test`. Wizard typecheck and the wizard suite never run in CI.
- **Outside both suites** — `scripts/smoke-test.js` (live post-deploy check via Railway
  GraphQL + `slack.com/api/auth.test`), `scripts/test-diff.mjs`, `scripts/jev-eval-harness.js`.

## Sharp edges worth knowing

- **The Core↔Wizard contract is a hand-maintained mirror.** No shared package, no schema
  generation, no version negotiation. Response types, `OPEN_STATUSES`, the ticket status
  groups and the behavior defaults are all duplicated across both packages.
- **The dashboard is console-locked unless configured.** Passcode login is disabled outright
  when `ORRY_DASHBOARD_PASSCODE` is unset, and the `dev-testing` auto-signin additionally
  requires `NODE_ENV=development` (`lib/web/auth.ts:11-16`). Deliberately fail-closed: with
  neither set there is no way in, which is the correct production posture but surprises anyone
  who expected the old `"orry"` default. Session cookies carry `Secure` except on plain-HTTP
  loopback (`lib/web/auth.ts:18-34`).
- **Quota is reported, never enforced by Core.** Usage is metered in `llm_usage`; the
  allowance lives only in Wizard's `wizard_entitlements`.
- `lib/identity.ts` is the bot's *self-description* corpus, not human identity resolution —
  a misleading filename.
