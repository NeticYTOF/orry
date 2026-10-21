# Rivet Hosted Deployment

One shared Rivet Core serves many programs. One Slack app, one `@Rivet`.

## What runs

- **Rivet Core** (`bun index.ts`): Slack Socket Mode, answer engine, tickets,
  background jobs (knowledge refresh, gap judging, weekly report, SLA loop,
  SQLite sweeper). Single replica is fine; several can run behind the same
  Slack app for read scale — runtime truth lives in the database, and
  destructive jobs take single-flight leases (`job_leases`).
- **Rivet Wizard** (Next.js): control plane for programs, tickets, knowledge,
  macros, analytics, incidents, retention. Optional at runtime — Core serves
  Slack from last-synced state while Wizard is down.
- **Postgres**: control-plane authority (programs, channels, helpers,
  audit). **SQLite** (`RIVET_DB_PATH`, on a persistent volume): runtime state,
  caches, source-cache fallback.

## Environment (Core)

Required: `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`,
`connections:write`), `SLACK_FAQ_CHANNELS`, and `OPENCODE_API_KEY` (default
intent/fallback key; add `_2`, `_3`… for rotation). `SLACK_HELP_CHANNEL` is
optional for a dedicated channel that replies to every top-level post.

Model cascade is automatic: HCAI → 9Router → OpenRouter → Zen standby, with
per-key cooldowns. HCAI task-specific models are controlled by `HCAI_MODEL`,
`HCAI_PING_MODEL`, `HCAI_HELP_MODEL`, `HCAI_INTENT_MODEL`, and
`HCAI_VISION_MODEL`; legacy intent defaults to `gpt-4.1-nano`. Ticketing works
with every provider down.

Hosted extras: `RIVET_WORKSPACE_ID` (Slack team id for tenant boundaries),
`RIVET_INTERNAL_TOKEN` (long random; enables `/internal/v1/*` for Wizard —
without it the dashboard cannot sync or act). `RIVET_SLA_CHECK_MIN` (default
15; 0 disables the stale-ticket loop). `RIVET_DB_PATH=/data/rivet.db` on the
volume.

## Slack app scopes

`chat:write`, **`chat:write.customize`** (program support identity; without a
re-authorization after adding it, branding falls back to plain Rivet),
`channels:history`, `groups:history`, `channels:join`, `app_mentions:read`,
`reactions:read`, `reactions:write`, `commands`, `im:history`, `im:write`,
`channels:read`, `groups:read`, `files:read`, **`users:read`** (names for the
bridge's user lookups; adding it needs a reinstall, which may need a workspace
admin). Socket Mode on, Interactivity
on, and `app_mention` subscribed. Generate the manifest with `bun run manifest` — command names derive from
`RIVET_BOT_SLUG`; command names use that configured slug, including the sources
and administration commands.

Regenerate + re-install the app only when scopes/commands change. Adding a
program never touches the manifest.

## Wizard env

`DATABASE_URL`, `SESSION_SECRET`, `HCA_CLIENT_ID` + `HCA_CLIENT_SECRET` (Hack
Club Auth), `RIVET_CORE_BASE_URL` + `RIVET_INTERNAL_TOKEN` (same token as
Core), `RIVET_WORKSPACE_ID`, `BASE_URL`, `CRON_SECRET` (the reconcile cron
refuses to run without it).
Wizard database migrations are versioned under `rivet-wizard/db/migrations/` and
run explicitly with `bun run migrate` from `rivet-wizard/`. The command uses
`DATABASE_URL`, creates `wizard_schema_migrations`, applies pending numbered SQL
files in one transaction, records each applied filename, and aborts on failure.
Run it against a disposable PostgreSQL database first, then against the Wizard
production database before deploying the Wizard service. Migrations are additive
and idempotent; do not reset or recreate the database. The People release adds
`wizard_people` and `wizard_global_access` through migration `001_people_access.sql`.

Wizard production deployment target: Railway service `rivet-wizard`, root
directory `rivet-wizard`, build handled by Railpack, runtime `next start`.
Core is a separate Railway service named `rivet` and must not be redeployed for
Wizard-only changes. Required Wizard environment includes `DATABASE_URL`,
`SESSION_SECRET`, Hack Club Auth credentials, `RIVET_CORE_BASE_URL`,
`RIVET_INTERNAL_TOKEN`, `RIVET_WORKSPACE_ID`, `BASE_URL`, and `CRON_SECRET`.

## Health

- Core: `/api/health` (console session) and `/internal/v1/health` (token) —
  models, channels, missing vars.
- Watch: Slack connectivity, knowledge `lastBuiltAt`, provider fallback rate,
  `job_leases` rows stuck with old `expires_at` (a crashed holder self-heals
  by expiry).
- Backups: SQLite via `VACUUM INTO` (never raw copy under WAL) +
  `integrity_check`; Postgres via your provider's backups; keep `BACKUP_MANIFEST.md`
  style records outside the repo.
