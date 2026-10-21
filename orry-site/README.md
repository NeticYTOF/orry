# LOADOUT ORRY help desk site (local build)

A website for Netic's Orry Slack bot: open tickets, closed-ticket statistics, My stats and a Leaderboard, behind an invite-only login. Everything here runs on **invented data** until you point it at a real bot.

## Try it

```
cd orry-site
npm install
npm run dev          # http://localhost:3200
```

The first run makes `data/site.db` and prints the invite links. Open http://localhost:3200/sign-in. Under the button is a **local-only dev panel** that stands in for Hack Club: pick Pat Placeholder (organizer) or Juno, Leila, Ravi, Mia, Noah (helpers). Zara is turned off. Start over with `npm run seed -- --force`.

Things to try: switch people with the sidebar user card; Board filters and the side sheet; Statistics tabs and the week picker; Closed tickets (select a number to filter); Leaderboard; as Pat, **Team and invites** (make an invite, open its link in a private window, choose that person in the dev panel) and **Config check**.

## Against the real bot code (still fake data)

Terminal 1: `cd ../orry-bot-patched && bun install && bun run dev:bridge` (port 4100, seeded fake database, no Slack).
Terminal 2: `ORRY_FIXTURES=0 RIVET_CORE_BASE_URL=http://127.0.0.1:4100 RIVET_INTERNAL_READ_TOKEN=dev-bridge-read-token npm run dev` (PowerShell: set the three variables with `$env:NAME="value"` first).

## Checks

```
npm run typecheck
npm test
npm run build
```

## Settings (environment)

| Variable | Meaning |
|---|---|
| `ORRY_DEV_AUTH=1` | Local dev sign-in panel (the default under `npm run dev`; never use in production) |
| `ORRY_FIXTURES=0` | Read the bridge instead of invented data |
| `RIVET_CORE_BASE_URL`, `RIVET_INTERNAL_READ_TOKEN` | Where the bot's bridge is, and its read-only token |
| `ORRY_NOW` | Fix "now" for the invented data |
| `ORRY_SITE_DB` | Path of the site database |
| `ORRY_HCA_CLIENT_ID`, `ORRY_HCA_CLIENT_SECRET` | Real Hack Club Auth (not tested against the real service) |

## Not done / not verified

Real Hack Club sign-in; the real Slack workspace; deployment to Nest; an accessibility audit; browsers other than Chromium.
