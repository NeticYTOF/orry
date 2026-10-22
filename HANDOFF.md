# Orry the ore Maulwürf — handoff

Everything another agent needs to pick this repo up cold. For rules and
architecture, read `AGENTS.md` first; this file is state, not policy.

## Where things stand

Orry the ore Maulwürf is a Slack help-channel
bot (Bun + TS, Socket Mode) serving **Loadout**, a Hack Club YSWS. It answers
from a program documentation corpus, escalates what it can't answer to human
helpers, and learns from resolutions.

- Repo: `https://github.com/NeticYTOF/orry` (public), branch `main`
- Local: `C:\Users\aarav\Projects\Rivet`
- Serving `#loadout` (main/ambient), `#loadout-help` (help/tickets),
  `#loadout-development` (weekly report + `@`-mentions only)
- Suite: **101/101 core + 20/20 wizard green**, typecheck + prettier clean
- Model: answers `deepseek/deepseek-v4-flash-0731`, intent
  `openai/gpt-4.1-nano`, both via Hack Club AI (`HCAI_API_KEY`)

## Local process state

| Process | What | Notes |
|---|---|---|
| `orry` | `bun index.ts`, detached | Running locally at last check; no service or scheduled-task supervisor was found. Stops if the process exits or the machine sleeps/restarts. |

The code and generated Slack manifest use Orry's name and `/orry` commands.
The installed bot profile still reported `rivet`; updating it through the
connected Slack profile tool returned `not_admin`. A workspace admin must
apply the new manifest or update the Slack bot profile.

## Credentials and local-only state

- `.env` — all keys. **Gitignored. Never commit, never print values.**
  Key names (values stay in the file): `HCAI_API_KEY`, `OPENCODE_API_KEY`
  (required by `validate()`; same credential), `HCAI_MODEL`,
  `SLACK_BOT_TOKEN` (`xoxb-`, Hack Club workspace, Slack profile still named
  `rivet` until its admin applies the new name),
  `SLACK_APP_TOKEN` (`xapp-`, `connections:write`), `SLACK_CLIENT_ID` /
  `SLACK_CLIENT_SECRET` (dashboard OpenID only), `ORRY_DASHBOARD_PASSCODE`,
  `ORRY_ANSWER_API_KEY` / `ORRY_ANSWER_BASE_URL` / `ORRY_MODEL` (route the
  hardwired 9Router help/ping tiers through HCAI), `INTENT_CLASSIFIER_*`
  (base URL, key, `openai/gpt-4.1-nano`; `INTENT_TIMEOUT_MS=45000`),
  `ORRY_REPORT_CHANNEL` (weekly report target), `VEY_ENABLED=0`
  (sidecar stopped; see below).
- `config/` — **gitignored** live deployment: `programs.json` with the real
  channel ids (`C0C5XUDMRH9` #loadout, `C0C6XBLM0M7` #loadout-help,
  `C0C68G3K0AJ` #loadout-development). Never commit.
- `rivet.db` — local SQLite runtime state. Never commit.
- Pre-push check, every time:
  `git grep -inE "xox[baprs]-|sk-hc-v1-|gh[pousr]_|sk-[A-Za-z0-9]{20,}|AKIA"`

## Loadout canon (bot's ground truth)

`jeremy341/loadout` is canonical — `loadout/corpus/*.md` (10 files) is
transcribed from it and the live site, in corpus voice. **Bolts** (global)
vs Track XP (per-track, permanent). Four tracks **Tools/Systems/Compute/
Hardware**, LV.15 cap, Research Mode is a modifier. Requisitions
LV.3/6/9/12/15. Custom tiers FIELD/POWER/ROOT/BARE METAL. AI cap 40%.
Quality: Originality/Technical Depth/Execution/Documentation. **Jerry leads;
Fazin/Wind and Netic co-organize; Netic built Orry.**
Program repo `jeremy341/loadout`, bot repo `NeticYTOF/orry`.
Casing: `Loadout`, `Hack Club`, `YSWS` — never `LOADOUT`/`Cores`/`yswe`.
`lib/loadoutProgram.test.ts` fails the build on drift.

## Recent work (newest first)

- Answers: verify each factual claim against same-program passages, select
  passage IDs for uncited claims, preserve grounded parts of compound answers,
  and state unresolved parts. Follow-up retrieval uses thread context while
  checking coverage against the current question; clarification keeps the
  requester's reply.
- Voice/branding: public name is **Orry the ore Maulwürf**, prefix `/orry`. Gentle German slang and mine-mole
  humor are prompt-guided; no profanity/controversy rule is deterministic.
  Generated Slack manifest has the new name, but the installed Slack profile
  still needs an admin update (`users.profile.set` returned `not_admin`).
  Makers grounded (identity + FAQ + pinned rule).
- `#loadout-development`: report target + `@`-mentions answered from the
  Loadout corpus; stays unclaimed otherwise. Mentions bypass the role gate.
- `#loadout` is main, `#loadout-help` files tickets/escalates.
- `SLACK_HELP_CHANNEL` optional; help wins over main on dual-role channels.
- Daily API cost digest in the report channel (reads `llm_usage`; pricing
  table now has the real measured $/1M).
- Minimal reasoning on answers (4.4s vs 15–40s). Intent on nano (1.4s).
- Engagement: verdict-first precedence, thread self-reference popped,
  classifier temperature 0.
- Hardening: dashboard passcode fail-closed, dev bypass needs
  `NODE_ENV=development`, `Secure` cookies off loopback.
- Reliability: `timeoutFetch` deadline race, 120s per-file test timeout,
  failure-cached `conversations.list`, `ORRY_SKIP_DOTENV` for tests.
- `--ask --program <id>` (was shared-corpus-only), `--doctor` with role
  validation, `slack-bootstrap.mjs`, smoke check [4/4], CI covers wizard
  via `run-tests.mjs --wizard` (never bare `bun test`).
- `channelPolicy.resolve` for `C0C68G3K0AJ` returns `role: none` — by
  design, not a bug.

## Open threads (not started)

1. **VPS deploy blocked on SSH.** Host alive (22ms ping), port 22 drops
   packets from here, 443/2222 fail. Proven sandboxed: raw TCP to GitHub
   also times out while HTTPS works — this runtime is HTTPS-proxy-only, so
   SSH can never work from here. User must SSH from a real terminal.
   Deploy then = clone + `config/programs.json` + provider `.env` values.
2. **VEY evaluated, rejected as classifier.** Structured lane tie-breaks
   alphabetically on ungrounded input (`compose.py`: `min(top, key=text)`).
   It's a fact-selector, not a labeler. `lib/veyDecision.ts` +
   `lib/vey/sidecar.py` remain for cost-routing only; `VEY_ENABLED=0`,
   sidecar stopped. Don't re-enable for engagement without new evidence.
3. **Rate-limit loop** (`conversations.list` 429s) was crashing the bot
   pre-fix; failure cache landed but long-term behavior under sustained
   throttling is unverified.
4. **Noisy-neighbor risk:** `docs/architecture.md` (20-agent survey) is a
   snapshot, not live docs — verify against code before trusting details.
5. **Stale branches:** `origin/master` (rename commit) and `origin/testing`,
   `origin/development` (loadout lanes) are historical; `main` is the line.

## First commands in a fresh session

```powershell
cd C:\Users\aarav\Projects\Rivet
git pull --ff-only; git status --short
bun index.ts --doctor        # expect 9 passed, 0 failures (1 passcode warn ok)
bun run test 2>&1 | tail -2  # expect 99/99 (wizard: bun run test:wizard, 19/19)
```

Then check the two processes are alive before doing anything else.
