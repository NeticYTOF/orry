# Putting Orry in a Slack workspace

Operator runbook for a single-workspace Orry deployment on Railway. Code-dependent
instructions link to the source files that implement them. Workspace-specific
values use placeholders.

Steps 1–4 happen once. Steps 5–7 are what you re-run after any env or code
change.

---

## 1. Create the Slack app from the generated manifest

Command names are derived from `RIVET_BOT_SLUG` (`lib/brand.ts`), and the
bot registers its listeners from the same slug. Generating the manifest rather
than writing it is what keeps the two in step — an app advertising
`/pixl-teach` while the process listens for `/orry-teach` fails silently, with
no error anywhere (`scripts/manifest.cjs`).

```sh
bun install
bun run manifest
```

The defaults generate `/orry`, `/orry-teach`, `/orry-gaps`,
and the other `/orry-*` commands. If you choose another display name or slug,
put the same `RIVET_BOT_NAME` and `RIVET_BOT_SLUG` in the runtime environment
before generating the manifest. **Slash command names are unique per workspace**
— two apps cannot both own `/orry`, so choose a free slug before installing.

In Slack:

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** →
   **From a manifest** → choose the workspace → paste the JSON.
2. **Install to Workspace.**

That single manifest sets, for you:

| Setting | Value | Where in the manifest |
| --- | --- | --- |
| Bot scopes | the 14 in `BOT_SCOPES` | `manifest.oauth_config.scopes.bot` in `scripts/manifest.cjs` |
| Bot events | the 8 in `BOT_EVENTS` | `scripts/manifest.cjs` |
| Slash commands | the 12 in `COMMANDS` | `manifest.features.slash_commands` in `scripts/manifest.cjs` |
| Socket Mode | on | `scripts/manifest.cjs` |
| Interactivity | on | `scripts/manifest.cjs` |

The manifest includes `app_mention` and `app_mentions:read`. Orry handles direct
pings through either that event or the message event and deduplicates by Slack
message ID. Re-apply the manifest after changing the event or scope list.

Regenerate and re-apply the manifest if you change the slug or the scope list —
the token's scopes are fixed at install time from `oauth_config.scopes.bot`
(`scripts/manifest.cjs`). Adding a program never touches the manifest.

## 2. Copy the two tokens

They are not interchangeable and they come from different screens.

| Variable | Slack screen | Prefix | Scope that matters |
| --- | --- | --- | --- |
| `SLACK_BOT_TOKEN` | **OAuth & Permissions** → **Bot User OAuth Token** | `xoxb-` | the bot scopes from step 1 |
| `SLACK_APP_TOKEN` | **Basic Information** → **App-Level Tokens** → **Generate** | `xapp-` | `connections:write` |

`SLACK_APP_TOKEN` is what authorises the Socket Mode connection itself; without
`connections:write` the process opens no connection and nothing arrives at all
(`.env.example`).

**Socket Mode means no ingress.** The bot dials out to Slack over a websocket and
listens on no port (`index.ts`, `socketMode: true`), so there is no public
URL, no domain, no tunnel, and no healthcheck — `Dockerfile` says so and
`railway.json` defines no port. The `RIVET_WEB_PORT` you may see referenced
(default `4100`, `lib/config.ts`) is the optional local web console, not how
Slack reaches the bot.

## 3. Collect the channel IDs

Right-click the channel in Slack → **View channel details**; the **ID** is at the
bottom of that panel. Names will not work (`.env.example`).

You need the FAQ channel ID, and may set a separate help channel:

- `SLACK_HELP_CHANNEL` — optional. Every top-level message in it gets a reply.
- `SLACK_FAQ_CHANNELS` — comma-separated IDs the bot watches. The **first** entry
  is the auto-reply channel: the one where the bot answers without being
  mentioned (`config.slack.autoReplyChannel` in `lib/config.ts`).

## 4. Set the variables on the service

Railway: service → **Variables**. The engine refuses to boot without the four
below and names every one that is missing rather than degrading into silent
fallbacks at answer time (`validate()` in `lib/config.ts`, called at startup in `index.ts`).

| Variable | Required | Where the value comes from |
| --- | --- | --- |
| `OPENCODE_API_KEY` | yes | model pool key. `MODEL_VARS` (`lib/config.ts`) — `_2`, `_3`… rotate (`lib/config.ts`) |
| `SLACK_BOT_TOKEN` | yes | step 2 |
| `SLACK_APP_TOKEN` | yes | step 2 |
| `SLACK_FAQ_CHANNELS` | yes | step 3 |
| `SLACK_HELP_CHANNEL` | no | step 3; a dedicated help channel that replies to every top-level post |
| `HCAI_API_KEY` | no | optional HCAI answer/help/ping/vision tiers (`.env.example`) |
| `RIVET_PROGRAMS_JSON` | no, but nothing to answer from without it | the program JSON **inline as a value**, not a path — step 5 |
| `RIVET_BOT_NAME` | no | step 1 |
| `RIVET_BOT_SLUG` | no | step 1. Must match the installed app exactly |
| `RIVET_ADMIN_USER_IDS` | no | your Slack user ID — profile → three dots → **Copy member ID**. **Fails closed**: empty means nobody can teach the bot anything (`.env.example`) |
| `RIVET_DB_PATH` | no | point at a volume, e.g. `/data/rivet.db` (`.env.example`) |
| `RIVET_WORKSPACE_ID` | no | Slack team id, for tenant boundaries on a hosted deployment |

Attach a volume mounted at `/data` **before the first deploy finishes**: the bot
opens its database on boot (`index.ts`), so a volume attached afterwards means
the first run wrote to a path that then disappeared. Without one, every redeploy
discards the answer cache, everything taught, ticket records, and the last-good
copy of the docs.

`bun scripts/slack-bootstrap.mjs` writes a `.env` skeleton with the required
names, prints the manifest, and lists the manual steps. It reads no environment
variable *values* and never prints a secret, and it refuses to overwrite an
existing `.env` (`scripts/slack-bootstrap.mjs`).

## 5. Give it something to answer from

`RIVET_PROGRAMS_JSON` is `JSON.parse`d straight from the variable
(`lib/programs.ts`) — it is the JSON itself, not a filename. Accepted
shapes are an array or an object with a `programs` array; entries without an
`id` are dropped (`lib/programs.ts`).

For this repo's bundled LOADOUT program, inline it:

```sh
bun -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("loadout/program.json","utf8"));console.log(JSON.stringify([p]))'
```

Two things to know about that file before you deploy it as-is:

- Its seven sources are `file://` URLs (`loadout/program.json`), resolved
  under the app root and refused if they escape it
  (`lib/knowledge.ts`). `Dockerfile` copies the whole repo into
  `/app`, so `file://loadout/corpus/…` does resolve in the image — but a
  deployment that ships only `lib/` will load zero sources.
- It claims the bundled LOADOUT channel ID in `channels`. Replace that value if
  your workspace uses a different channel. It intentionally has no
  `helpChannel`, so the program channel runs in normal mode.

A source that loads but has nothing about your question produces a decline, not
an invention — that is the intended behaviour (`lib/respond.ts`).

## 6. Read the boot log

Railway: service → **Deployments** → latest → **Logs**. A typical boot ends with
these three lines, in this order:

```
[rivet/db] opened /data/rivet.db
[rivet/knowledge] corpus refreshed — 7/7 sources loaded
[rivet/bot] connected via Socket Mode as U01ABCDEF
```

- `[rivet/db] opened …` — `lib/db.ts`, on its way to `index.ts`. Before
  it, one `[rivet/db] migrated: <column>` line per schema addition is normal and
  only happens once per database.
- `corpus refreshed — N/M sources loaded` — `lib/knowledge.ts`. **`N` must
  equal `M`.** `0/0` means nothing is configured to answer from; `3/7` means
  four sources failed, and the reason is on a `[rivet/knowledge] failed to fetch
  "<name>": …` line just above (`lib/knowledge.ts`).
- `connected via Socket Mode as U…` — `index.ts`, printed after `app.start()`
  (`index.ts`) and `auth.test` (`lib/config.ts`). The `U…` is the bot
  user id. If this line is missing, the process did not finish starting.

The bot waits up to 30 seconds for its initial corpus refresh before opening
Socket Mode. If a slow source exceeds that limit, the log says it is connecting
while the refresh continues. It restores stable last-good source copies first,
when available; dynamic sources wait for a fresh result before they can support
exact claims. Check the corpus refresh line later to confirm every source loaded.

`missing required environment variable: …` anywhere in the log means step 4 is
incomplete — the message names the exact variables (`lib/config.ts`).

## 7. Smoke test the deployment

The build being green only means the process started. Prove the bot answers.

```sh
bun run smoke
```

`bun run smoke` is `node scripts/smoke-test.js` (`package.json`). It reads the
**live** service variables over Railway's GraphQL API
(`scripts/smoke-test.js`), so it tests what is deployed, not what is in
your shell.

It needs four shell variables of its own
(`scripts/smoke-test.js`):

| Variable | Where to get it |
| --- | --- |
| `RAILWAY_TOKEN` | [railway.com/account/tokens](https://railway.com/account/tokens), account-scoped (`scripts/migrate-railway.mjs`) |
| `RAILWAY_PROJECT_ID` | Railway project → **Settings** |
| `RAILWAY_ENVIRONMENT_ID` | Railway project → **Settings** → the environment |
| `RAILWAY_SERVICE_ID` | the Rivet service's **Settings** tab |

Checks run in order and it exits on the first hard failure:

1. `[1/4]` the latest deployment's log contains `connected via Socket Mode`
   (`scripts/smoke-test.js`).
2. `[2/4]` the engine loads a program and sees its sources under the new env
   (`scripts/smoke-test.js`).
3. `[3/4]` `auth.test` against the deployed `SLACK_BOT_TOKEN` — right team, right
   bot (`scripts/smoke-test.js`).
4. `[4/4]` **the bot actually answers.** Checks 1–3 all pass on a bot that boots
   and then declines everything, because nothing has asked it a question yet.
   This one loads the configured program, asserts its sources load, then runs the
   engine's own `--ask` path (`index.ts`) and requires a *grounded* answer —
   non-empty, from a real source, and not one of the bot's declines. Grounding is
   judged by `lib/respond.isGroundedAnswer` (`lib/respond.ts`), the same
   function the bot uses on itself, so the two cannot drift.

The default question is `what is the program's currency?`, which the bundled
LOADOUT corpus answers (`loadout/corpus/03-economy.md`,
`loadout/corpus/02-tracks.md`). For a different program, point it at something
your docs cover:

```sh
RIVET_SMOKE_QUESTION="how do I submit my project" RIVET_SMOKE_PROGRAM=myprogram bun run smoke
```

Check 4 needs `bun` on your PATH and a `RIVET_PROGRAMS_JSON` with a `sources`
array on the service. When either is missing it prints `SKIP:` with the reason and
what to do about it, and moves on (`scripts/smoke-test.js`) — it never
passes silently.

### If check 4 fails

| Message | Meaning |
| --- | --- |
| `declares N source(s) and loaded none of them` | the source URLs are wrong, or the files they point at are not in the image. Check step 6's `corpus refreshed` line for the per-source reason. |
| `the bot declined …` | the sources loaded but did not answer the question. Either the question is not in your corpus, or a source is the wrong document. Wording is not asserted, so this is not a phrasing fluke. |
| `--ask failed` with `missing required environment variable` | step 4 is incomplete; the message names the variable. |

### Verify in Slack

Once the smoke test passes, in the workspace:

- `/orry-sources` (or `/<your-slug>-sources`) — what loaded and when it last refreshed.
- `/orry <question>` — a private answer, no channel clutter. The question is the
  whole argument: `/orry what is the deadline`, not `/orry ask what is the
  deadline` — there is no `ask` subcommand.
- Post in the help channel — every top-level message gets a reply there.

If a command silently does nothing, suspect a slug mismatch between the installed
app and `RIVET_BOT_SLUG`, not Slack. If `/orry-sources` is the only thing that
answers, the program is loaded but owns no channels — step 5.
