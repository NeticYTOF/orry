# Run your own copy

Rivet is one program. What makes it *your* program's bot is configuration —
nothing in this repo needs editing. Fork it, set some variables, deploy. About
twenty minutes, most of it waiting on Slack's UI.

The tradeoff to know up front: a fork gets you full control and the ability to
hack on the code, but it doesn't get upstream fixes automatically. See
[Staying current](#staying-current) at the end.

---

## 1. Fork and get a model key

Fork this repo on GitHub.

You need `OPENCODE_API_KEY` for the default intent classifier and fallback
tiers. Hack Club AI is also supported: `HCAI_API_KEY` enables its answer tiers,
and the per-task `HCAI_*_MODEL` variables select their models. See
[`.env.example`](../.env.example) for the current provider settings.

## 2. Create the Slack app

The manifest depends on what you name your bot, so generate it rather than
writing it by hand:

```sh
bun install
bun run manifest
```

The default slug is `orry`, producing `/orry`, `/orry-teach`, `/orry-gaps`,
and the other commands. If you choose another slug, set the same
`RIVET_BOT_SLUG` in the deployment environment before generating the manifest;
the installed commands and runtime listeners must match.

One constraint that matters if your workspace already has a bot using the same slash commands:
**slash command names are unique per workspace.** Two bots can't both own
`/orry`. If the name is taken, choose another slug before generating the
manifest.

Then, in Slack:

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** →
   **From a manifest** → pick your workspace → paste the JSON.
2. **Install to Workspace.**
3. **OAuth & Permissions** → copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information → App-Level Tokens** → **Generate** one with the
   `connections:write` scope → copy it (`xapp-…`).

The manifest already turns on Socket Mode, which is why this bot needs no public
URL, no domain and no tunnel — it dials out to Slack rather than being called.

Last thing: get the **channel IDs** you want it in. Right-click a channel → View
channel details → the ID is at the bottom. Names won't work.

## 3. Describe your program

One JSON value carries the whole thing — channels, docs, behaviour:

```json
[{
  "id": "example",
  "name": "Example",
  "channels": ["C_MAIN"],
  "posture": "active",
  "scope": "program",
  "sources": [
    { "name": "Example Docs", "type": "url", "url": "https://example.invalid/docs" },
    { "name": "Example FAQ", "type": "json-faq", "content": [
      { "question": "What is this program?", "answer": "Read the configured program documentation." }
    ]}
  ],
  "milestones": [
    { "name": "Example milestone", "date": "2030-01-01" }
  ]
}]
```

Minified, that becomes `RIVET_PROGRAMS_JSON`. Set it to override the ignored
`config/programs.json` fallback — the bundled `loadout/program.json` is an
example and is not loaded automatically.

**Source types.** `url` for a docs site (it follows subpages); `github-dir` for a
directory of markdown via the GitHub contents API (add `siteUrl` to read the
rendered pages instead of raw markdown with unfilled placeholders); `json-faq`
for question/answer pairs, either inline as `content` or fetched from a `url`;
`text` for inline prose.

**posture** — `active` answers whenever it can, `passive` only when addressed,
`muted` stays silent (useful while you're still setting up).

**scope** — `program` answers questions about your program and leaves everything
else to the humans in the channel; `any` answers whatever anyone's stuck on.
Being pinged or DM'd bypasses both.

**milestones** are dates the bot answers from directly rather than guessing at.
"Is it out yet" is the question docs are worst at and people ask most.

## 4. Deploy

Any host that runs [Bun](https://bun.sh) works. Railway is what this repo is
set up for — it has a `Dockerfile` and a `railway.json` already.

**New Project → Deploy from GitHub repo → your fork.**

Then, before the first deploy finishes, **add a volume mounted at `/data`**
(service → Settings → Volumes). Do this first: the bot opens its database on
boot, so a volume attached afterwards means the first run wrote to a path that
then disappeared. Without a volume at all, every redeploy discards the answer
cache, everything the bot has been taught, ticket records, and the last-good copy
of your docs.

Variables:

```sh
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_FAQ_CHANNELS=C_MAIN             # must match a configured program channel
SLACK_HELP_CHANNEL=C_HELP              # optional dedicated help channel
OPENCODE_API_KEY=...

RIVET_BOT_NAME=Orry the ore Maulwürf
RIVET_BOT_SLUG=orry
RIVET_ADMIN_USER_IDS=U01ABCDEF        # your Slack user ID
RIVET_DB_PATH=/data/rivet.db
RIVET_PROGRAMS_JSON=[{"id":"example",...}]
```

The four listed provider and Slack values are validated at boot; the process
refuses to start without them and names anything missing. `SLACK_HELP_CHANNEL`
is optional; set it only for a dedicated channel that should reply to every
top-level post. The `SLACK_APP_TOKEN` must be the Socket Mode `xapp-` token with
`connections:write`; a Pixl `SLACK_SIGNING_SECRET` is not used by Orry.

`RIVET_ADMIN_USER_IDS` **fails closed**: leave it empty and nobody, including
you, can teach the bot anything. Your Slack ID is in your Slack profile → three
dots → Copy member ID.

[`.env.example`](./.env.example) documents everything else, all optional.

Deploy. The logs should say `connected via Socket Mode as U…`, and the commands
from the generated manifest should appear in Slack.

## 5. Check it actually works

A green build only means the process started.

Invite the bot to any private channels by hand — it self-joins public ones on
boot. Then ask it something your docs cover and confirm an answer comes back.
`/orry-sources` (or `/<your-slug>-sources`) shows what it managed to load, which is the fastest way to spot a
docs URL that 404s.

If it's quiet: `RIVET_DEBUG=1` for per-message logging, and check `posture` isn't
`muted`.

---

## Running it locally first

Worth doing before you deploy — same bot, no host:

```sh
bun install
cp .env.example .env    # fill it in
bun start
```

Socket Mode means this connects to your real Slack workspace from your laptop
with no tunnel. Use a scratch channel.

To check answers without Slack at all:

```sh
bun index.ts --ask "how do i submit my project"
```

That builds the corpus and prints what the bot would have said. It's the quickest
way to tell whether your sources are actually loading.

---

## Adding to what it knows

Three ways, in increasing order of effort.

**Teach it directly.** `/orry-teach how do i submit :: open a PR against the
projects repo`. Available to `RIVET_ADMIN_USER_IDS` only, and it takes effect
immediately.

**Let it capture answers.** When a human answers a question the bot couldn't, it
notices and queues that answer for review. `/orry-pending` lists the queue,
`/orry-approve <n>` accepts one. Nothing enters the corpus unapproved.

**Fix the docs.** `/orry-gaps` is the list of questions your documentation
couldn't answer, ranked by how often they were asked. That's a to-do list rather
than a bug list — the point of the bot is partly to generate it.

---

## Staying current

A fork doesn't follow upstream. GitHub's **Sync fork** button handles it while
you haven't touched the code; once you have, it's a merge like any other.

The alternative, if you don't intend to modify anything: point Railway at
`NeticYTOF/orry` directly instead of a fork. Every push here then
redeploys your bot automatically. You get fixes for free and give up the ability
to change the code — a reasonable trade if configuration is all you need, which
for most programs it is.

If you do modify things, the pieces most likely to conflict are `lib/commands.js`
and `lib/respond.js`, so prefer adding files over editing those where you can.

---

## Things worth knowing before you commit to this

**Your bot reads your channels.** It stores recent messages, questions asked, and
who asked them in its SQLite database, so it can follow a conversation. That
database lives on your volume, in your Railway project. Nothing is sent anywhere
except to the model provider you configured. Tell your community it's there.

**Model calls can be rate-limited.** The deployment uses the provider keys you
configure, with optional HCAI and OpenCode key pools. If a provider is temporarily
unavailable, the bot retries within its request budget and then returns a
temporary-error response.

**It can be wrong.** Everything is grounded in your docs and it's built
throughout to say "I'm not sure" rather than guess — but a docs page that's out
of date produces a confidently out-of-date answer. `/orry-reload` re-fetches
without a restart.

**Get the slug right the first time.** It's the one field that's genuinely
painful to change later.
