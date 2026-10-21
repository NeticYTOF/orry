# Slack setup

From a fresh clone to a bot answering in Slack. Every step below is grounded in
the code; where a claim could not be verified in this repository it is marked
**unverified**.

The mechanical half of this is one command:

```sh
bun install
bun scripts/slack-bootstrap.mjs
```

It writes a `.env` skeleton with empty values (refusing to touch an existing
`.env`), prints the Slack app manifest, and prints the remaining manual steps.
The rest of this document is what it cannot do for you.

For a fork you intend to keep current, see [self-hosting.md](self-hosting.md)
instead — this page is the Slack half only.

---

## 1. Generate the manifest, never write it by hand

`scripts/manifest.cjs` is the single source of truth for scopes, bot events, and
the twelve slash commands. Read it as JSON:

```sh
bun run manifest
```

It reads `RIVET_BOT_NAME` and `RIVET_BOT_SLUG` from the environment
(`lib/brand.ts`) and builds every command name from the slug
(`lib/brand.ts`), which is the same function `lib/commands.ts`
uses to register the listeners.

The header comment of `scripts/manifest.cjs` states the failure mode directly
(`scripts/manifest.cjs`): command names come from `RIVET_BOT_SLUG`, and
hand-editing a manifest is how you end up with an app advertising
`/pixl-teach` while the process listens for `/orry-teach` — a failure with no
error anywhere, because Slack is perfectly happy with a command nobody handles.
The manifest is not documentation of the bot; it is what Slack is told exists.

Consequences worth knowing before you pick a slug:

- **Slash command names are unique per workspace.** Two apps cannot both own
  `/orry`; the second fails to install. Rename now, not later
  (`.env.example`).
- **Regenerate after changing the slug.** A manifest generated with one slug and
  an app configured with another is exactly the silent failure above. The bot
  token's scope list is also fixed at install time from
  `oauth_config.scopes.bot` (`scripts/manifest.cjs`), so changing
  `BOT_SCOPES` needs a manifest re-apply, not just a restart.

## 2. Create the app from that manifest

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** →
   **From a manifest** → choose your workspace → paste the JSON from
   `bun run manifest`.
2. **Install to Workspace.**

Socket Mode is already on in the generated manifest
(`scripts/manifest.cjs`, `socket_mode_enabled: true`, with a comment
noting it must stay true). The manifest also subscribes to message events and
`app_mention`, with the `app_mentions:read` scope (`scripts/manifest.cjs`).
Orry accepts direct pings through either event and deduplicates them. Re-apply
the manifest after changing event subscriptions or scopes.

## 3. The two tokens are not interchangeable

| | Where it comes from | Variable | Prefix |
| --- | --- | --- | --- |
| Bot token | OAuth & Permissions → Bot User OAuth Token | `SLACK_BOT_TOKEN` | `xoxb-` |
| App-level token | Basic Information → App-Level Tokens → Generate | `SLACK_APP_TOKEN` | `xapp-` |

The app-level token needs the **`connections:write`** scope
(`.env.example`); that is what authorises the Socket Mode connection
itself. Without it the process cannot open a Socket Mode connection, so nothing
arrives at all.

**Socket Mode means no ingress.** The bot dials out to Slack over a websocket and
listens on no port, so there is no public URL, no domain, no tunnel and no
reverse proxy to configure (`.env.example`, `scripts/manifest.cjs`).
The port you may see referenced elsewhere (`RIVET_WEB_PORT`, default `4100`, at
`lib/config.ts` and `lib/web/serve.ts`) is the optional local web
console, not how Slack reaches the bot. Unlike Pixorpheus's HTTP receiver, Orry
needs an `xapp-` app-level token; `SLACK_SIGNING_SECRET` is not used.

## 4. Required environment variables

`validate()` in `lib/config.ts` throws at startup, naming everything
absent, rather than degrading into silent fallbacks at answer time. The required
set is `MODEL_VARS` plus `SLACK_VARS`, enforced by `validate()` in `lib/config.ts`:

| Variable | What it is |
| --- | --- |
| `OPENCODE_API_KEY` | OpenCode Zen key for the default intent classifier and fallback tiers; `_2`, `_3`… rotate |
| `SLACK_BOT_TOKEN` | the bot token from step 3 |
| `SLACK_APP_TOKEN` | the app-level token from step 3 |
| `SLACK_FAQ_CHANNELS` | comma-separated channel IDs the bot watches; the **first** entry is the auto-reply channel |

`SLACK_HELP_CHANNEL` is optional. Set it only for a dedicated support channel
that should answer every top-level post; omit it for an all-normal program
channel. Channel IDs, not names: right-click a channel → View channel details →
the ID is at the bottom (`.env.example`).

`HCAI_API_KEY` is optional. When configured, it enables HCAI answer, help, ping,
and vision tiers. `INTENT_CLASSIFIER_MODEL` overrides the default legacy intent
model; `HCAI_INTENT_MODEL` routes that classifier through HCAI.

## 5. Give it something to answer from

Orry answers from a program corpus. With no program configured, `programs.all()`
is empty and there is no knowledge to retrieve.

`RIVET_PROGRAMS_JSON` takes the program's JSON **inline as a value** — it is
`JSON.parse`d straight from the variable (`lib/programs.ts`). It is not
a path to a file. Setting it to `loadout/program.json` logs
`RIVET_PROGRAMS_JSON is not valid JSON … — falling back to files` and configures
zero programs (verified by running the loader that way). Accepted shapes are an
array, or an object with a `programs` array (`lib/programs.ts`); entries
without an `id` are dropped (`lib/programs.ts`).

To run this repo's bundled LOADOUT program, inline its contents:

```sh
bun -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("loadout/program.json","utf8"));console.log(JSON.stringify([p]))'
```

Paste that single line into `.env` as the value of `RIVET_PROGRAMS_JSON`.

Two things to know about that file:

- Its sources are `file://` URLs (`loadout/program.json`, seven entries under
  `sources`) resolved relative to the app root and refused if they escape it
  (`lib/knowledge.ts`, `lib/knowledge.ts`), so they only work from
  this checkout — not from a deploy with the file absent.
- It claims the `#loadout` channel ID in `channels`. Replace that ID if your
  Slack workspace uses a different channel. It intentionally has no
  `helpChannel`, so this is a normal program channel that answers questions
  without replying to every top-level post.

Channel *ownership* is separate from `SLACK_FAQ_CHANNELS`: `isMainChannel()` also
accepts any channel in `config.slack.faqChannels` (`lib/channelPolicy.ts`),
so a program with `channels` set behaves correctly on the channel you named in
step 4.

## 6. Verify without Slack

```sh
bun index.ts --ask "how do i get started"
```

`--ask` runs `validate({ needsSlack: false })` (`index.ts`), so it needs
the model key but none of the four Slack variables — you can prove retrieval and
answering work before the app exists. It builds the corpus and prints what the
bot would have said.

## 7. Smoke test in Slack

Start the bot with all four required variables set:

```sh
bun index.ts
```

Then, in Slack:

- `/orry-sources` — what loaded and when it last refreshed
  (`lib/commands.ts`).
- `/orry <question>` — a private answer, no channel clutter
  (`lib/commands.ts`; the manifest's usage hint is `[question]`,
  `scripts/manifest.cjs`). The question is the whole argument: `/orry what is
  the deadline`, not `/orry ask what is the deadline` — there is no `ask`
  subcommand, and the bare word would just be searched for.
- Post in the help channel — every top-level message gets a reply there.

If a command silently does nothing, suspect a slug mismatch between the app and
`RIVET_BOT_SLUG`, not Slack. If `/orry-sources` is the only thing that answers,
the program is loaded but owns no channels (step 5).

---

## Footguns in the web console, verified in this codebase

Both concern the optional web console (`lib/web/serve.ts`), not the Slack path.
They matter only if you start the console during setup.

**1. `SLACK_CLIENT_ID=dev-testing` is a developer bypass — and it takes two
variables to arm.** `handleAuth()` issues a signed admin session cookie with no
credential at all (`lib/web/serve.ts`), and `isAdminSession()` grants
that session admin rights (`lib/web/auth.ts`). The gate is
`devAuthEnabled()`, which requires **both** `SLACK_CLIENT_ID === "dev-testing"`
**and** `NODE_ENV === "development"` (`lib/web/auth.ts`) — the sentinel
client ID alone does nothing, which is the deliberate design noted at
`lib/web/auth.ts`. The footgun is the pair: set both in a real deployment
and every visitor is an admin. Never ship `NODE_ENV=development`.

**2. `RIVET_DASHBOARD_PASSCODE` is fail-closed, not a default.** An unset
passcode resolves to `null` (`lib/web/serve.ts`) and passcode login is
refused outright with a 503 and an error naming the variable
(`lib/web/serve.ts`) — there is no guessable default password. Set
`RIVET_DASHBOARD_PASSCODE` to anything before running the console, and note
that with `SLACK_CLIENT_ID` unset there is no Slack login to fall back to
(`lib/web/serve.ts`), so an unconfigured passcode means the console is
simply closed rather than quietly open.

Neither variable appears in `.env.example` — verified by grepping it: it
documents neither `RIVET_DASHBOARD_PASSCODE` nor `NODE_ENV`. If you start the
console, read `lib/web/serve.ts` before assuming anything about who can
get in.

> These two were weaker earlier in this repo's history: the passcode used to
> fall back to the literal `"rivet"`, and the sentinel client ID alone unlocked
> admin. Both are fixed in the current tree; this note is here because older
> forks and older write-ups still describe the old behaviour.

## Unverified

- The exact Slack UI labels and click-paths change with Slack's admin console;
  only the app-manifest flow and the two token locations are confirmed by this
  repository (`.env.example`, `scripts/manifest.cjs`).
- Whether Slack still permits more than one app per workspace owning
  `/orry`-style command names is Slack-side policy, not code.
