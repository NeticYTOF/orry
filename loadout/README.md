# Orry the ore Maulwürf × Loadout

Orry the ore Maulwürf is configured here as the helper bot for **Loadout**, the YSWS where every project levels you up as a builder. Everything a builder asks in `#loadout` is answered from `corpus/`, so Orry stays grounded in the actual program rules instead of improvising.

## What is in here

- `program.json` — the drop-in program config: sources, pinned rules, links, escalation behaviour.
- `corpus/01-program.md` — what LOADOUT is, the loop, Digital vs Physical Loadout.
- `corpus/02-tracks.md` — the four tracks, Research Mode, levels, and field pricing.
- `corpus/03-economy.md` — Bolts vs Track XP, the four quality dimensions, Signal Bonus, Requisitions, the AI cap.
- `corpus/04-shop.md` — shop categories and mix, shop suggestions, Custom Order tiers.
- `corpus/05-eligibility.md` — what counts as a project, higher/lower fit examples, unconfirmed data.
- `corpus/06-timeline.md` — timeline, where to find people, feedback the maintainers want.
- `corpus/07-faq.md` — the same facts as Q&A, for phrasing that matches a question.
- `corpus/08-public-copy.md` — tightened Slack Canvas and website copy. Not a bot source; reference material.

## Wire it up

`program.json` is a **single program object**, so wrap it depending on how you supply it.
`RIVET_PROGRAMS_JSON` accepts only an array or `{ "programs": [...] }` — handing it the bare
object logs a warning and silently falls back to files, so the program never loads.

**Option A — env var.** Wrap the contents in an array:

```powershell
$env:RIVET_PROGRAMS_JSON = "[" + (Get-Content .\loadout\program.json -Raw) + "]"
bun index.ts --doctor   # confirms the program and all 7 sources resolved
bun index.ts
```

**Option B — file.** `config/programs.json` is an array of programs, so add this one as an
element of it (or create the file as `[{ ...this file... }]`). Env config takes precedence
over the file.

Always confirm with `bun index.ts --doctor` — it fails loudly when the program config is the
wrong shape or a `file://` source no longer resolves.

The bundled `channels` entry is `C0C5XUDMRH9`. Make sure that is the real
LOADOUT channel ID in your workspace and that `SLACK_FAQ_CHANNELS` includes it.
If your channel has a different ID, update both values in the program and env.
For additional program channels, use:

```
/orry-program channels add C0000000000,C1111111111
```

`program.json` ships with `"scope": "program"`; Orry ignores channels the
program has not claimed.

## Ground rules the bot enforces

`pinnedRules` in `program.json` plus `requireGroundedAnswer` are what stop Orry from confidently getting Loadout wrong. The load-bearing ones:

- Bolts are the global spendable currency; Track XP is separate, non-spendable, and permanent.
- Four tracks: Tools, Systems, Compute, Hardware. Research Mode is a modifier, not a track.
- Each track caps at LV.15. Requisitions land at LV.3/6/9/12/15; Custom Order tiers at
  FIELD LV.4, POWER LV.8, ROOT LV.12, BARE METAL LV.15.
- Dates, eligibility, prices, inventory, sponsors, and participation numbers are unconfirmed and must never be stated as fact.

Because `requireGroundedAnswer` is on, a question the corpus does not cover produces an "I don't have that confirmed" and a ticket for a human maintainer, rather than a plausible-sounding invention. That is the intended behaviour — an unanswerable question should reach a maintainer, not get guessed at.

## Editing the corpus

Edit the markdown, then force a refresh:

```
/orry-sources
/orry-reload
```

Orry re-reads `file://` sources from disk, so no restart is needed. Any change to the economy numbers is a maintainer decision — do not edit the economy numbers without the maintainers confirming them first.

## Canonical source

The canonical model is the `jeremy341/loadout` repository — `PLAN/00_LOADOUT_CANONICAL_INDEX.md`
and `PLAN/01`/`PLAN/02` — which the LOADOUT maintainers have confirmed as authoritative over
earlier drafts. Numbers here are transcribed from those plans: Bolts and Track XP split
(`PLAN/02` §3), Requisition milestones at LV.3/6/9/12/15 (`PLAN/02` §…), Custom Order tiers
FIELD/POWER/ROOT/BARE METAL at LV.4/8/12/15 (`PLAN/02` §28.1), the 40% AI cap (`PLAN/01`), and
the four quality dimensions Originality / Technical Depth / Execution / Documentation
(`PRODUCT.md` §Capabilities).

An earlier Slack draft described a different model — five tracks including Build and Research,
a currency called "Cores", and a 25%-capped reduction coupon every 3 levels. That draft is
superseded. `lib/loadoutProgram.test.ts` fails the build if any of those terms reappear in the
corpus, so the bot cannot silently drift back to it.

When the plans change, update the corpus and the tests together. Do not let the two disagree.
