# Bridge mode: the site on the real bot code

`npm run dev` shows invented fixtures. Bridge mode shows the same pages over
Orry's real bridge routes instead, served by the bot's dev bridge
(`bun run dev:bridge` in `orry-bot-patched`). The dev bridge runs only Core's
web server on `127.0.0.1:4100`, over a fresh invented database, with no Slack
connection and no model keys. Nothing real is read or sent.

## Start it: two terminals

Terminal 1, the dev bridge:

```
cd <path-to-bot-checkout>
bun install
bun run dev:bridge
```

Wait for `[dev-bridge] Orry Core bridge on http://127.0.0.1:4100`. It prints
two local tokens. The site needs only the read-only one,
`dev-bridge-read-token`.

Terminal 2, the site, in PowerShell:

```
cd <path-to-site-checkout>
$env:ORRY_FIXTURES="0"; $env:RIVET_CORE_BASE_URL="http://127.0.0.1:4100"; $env:RIVET_INTERNAL_READ_TOKEN="dev-bridge-read-token"; npm run dev
```

Or in Git Bash:

```
cd <path-to-site-checkout>
ORRY_FIXTURES=0 RIVET_CORE_BASE_URL=http://127.0.0.1:4100 RIVET_INTERNAL_READ_TOKEN=dev-bridge-read-token npm run dev
```

Open http://localhost:9995 and use the dev panel on the sign-in page. Sign in
as Pat Placeholder (organizer) or Juno Baker (helper). In PowerShell the
`$env:` values stay set for that window; close it, or set
`$env:ORRY_FIXTURES="1"`, to go back to fixtures.

Stop both with Ctrl+C. The dev bridge deletes its database when it stops, and
the next run starts with new invented data.

## Check it without a browser

With the dev bridge running:

```
ORRY_FIXTURES=0 RIVET_CORE_BASE_URL=http://127.0.0.1:4100 RIVET_INTERNAL_READ_TOKEN=dev-bridge-read-token npx tsx scripts/bridge-check.ts
```

It reads every page's view-model as an organizer and as a helper, prints the
headline numbers, checks the privacy rules (sensitive text withheld until a
logged reveal, tombstones for deleted and edited questions, tickets outside
Loadout's channels shown to organizers only, no text in the caches or the
access log) and exits 1 on a shape mismatch or a privacy failure.
`--fixtures` runs the same checks over the fixtures, to compare the numbers.
`--record test/fixtures/bridge` saves the responses for
`test/data-bridge-contract.test.ts`; re-record after a bot change to the
bridge routes.

## What differs from the fixtures

- Smaller history: about 13 tickets a week for 12 weeks (154 in all), not 50
  a week. The weeks end at the real current week, not at a fixed date.
- Names come from the fake Slack client: its display names are the handles
  (`pixel-otter`), so the Names view shows handles too (the site uses the
  Slack display name first, as Slack does). The invite search also matches
  real names, so "juno" still finds Juno Baker.
- The organizer channel is set, so ticket cards are on.
- Reopened tickets show "Unknown: not checked yet" until the site has read
  their events in the background (one ticket every 5 seconds).

## A one-command script (for the owner of package.json)

`npm run dev:bridge-mode` does not exist yet: package.json scripts belong to
the CORE part of the build. If it is added, it should set the three values
above only when they are not already set, then run `scripts/dev.ts`. Setting
`VAR=value` in an npm script does not work in PowerShell or cmd, so either
let `scripts/dev.ts` take a `--bridge` flag (and not pass it on to
`next dev`), or use Node's env file option:

```
"dev:bridge-mode": "tsx --env-file=docs/bridge-mode.env scripts/dev.ts"
```

with `docs/bridge-mode.env` holding the three lines
`ORRY_FIXTURES=0`, `RIVET_CORE_BASE_URL=http://127.0.0.1:4100` and
`RIVET_INTERNAL_READ_TOKEN=dev-bridge-read-token` (the fixed local dev token,
not a secret). Node's env file never overrides a value already set, so the
terminal can still point the site somewhere else. The dev bridge still has to
run in its own terminal.
