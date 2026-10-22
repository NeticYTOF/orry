# Golden question set (Loadout)

`loadout.jsonl` holds one golden case per line. Each case has a question, paraphrases, facts the answer must contain, claims it must not make, and a verdict.

## Commands

Run these from the repo root.

**Offline test (no model, CI):**

```
bun test scripts/golden-eval.test.ts
```

It checks the file: valid JSON, required fields, unique ids, string paraphrases, that each required fact appears in `loadout/corpus/*.md`, and the offline verdict classifier.

**Offline listing (no model):**

```
bun scripts/golden-eval.ts
```

It prints one line per case with status "not run".

**Live run (manual, calls the model):**

Needs a `.env` at the repo root with `OPENCODE_API_KEY`. Copy `.env.example` to `.env` and fill in the key. Do not commit `.env`.

```
bun scripts/golden-eval.ts --live
```

Flags:

- `--runs N` sends each case N times (default 1). Every run skips the answer cache, so each run is a fresh model call. Use 3 to see whether an answer is stable.
- `--out <path>` also writes the full results as JSON: the question, each run's verdict, source, answer text, missing required facts and forbidden claims made. Keep result files out of commits, for example `--out ../golden-results.json`.

Example: `bun scripts/golden-eval.ts --live --runs 3 --out ../golden-results.json`

The live run loads the program from `loadout/program.json` and uses an in-memory database unless `ORRY_DB_PATH` is set. It does not write `rivet.db`.

Each case prints one line: `id | expect | got | required ok | forbidden ok`. With `--runs` above 1, `got` lists the verdict counts (for example `CASE1x2,CASE2x1`) and the ok columns show `k/N`. The end of the run prints totals, how often the verdict matched `expect`, and how many runs missed a required fact or made a forbidden claim. The command exits 0 after printing these totals, even when checks fail. Read the totals and the JSON file to judge the run.

## Verdicts

- **CASE1**: the docs answer the question. The reply must include the required facts and avoid the forbidden claims.
- **CASE2**: the docs do not answer it. The bot should say so and not guess.
- **SILENT**: chatter or a message that needs no docs answer. No program pitch.

Unverified topics (the IRL event) are CASE1: the correct answer is "not verified".

## How a live reply is classified

The rules run in this order (`classifyResult` in `scripts/golden-eval.ts`):

1. A `silent` flag on the result gives SILENT.
2. An `unclear` flag, an empty answer, or an answer of `UNCLEAR` gives CASE2.
3. No source, an empty source, or source `NONE` gives CASE2.
4. Anything else (a source and text) gives CASE1.

A run that throws is counted as `ERROR` and fails its required-fact check. Required facts are matched as case-insensitive substrings of the answer, with whitespace collapsed. Forbidden claims must not appear in that same text.
