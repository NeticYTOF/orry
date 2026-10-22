// Run with: bun test scripts/golden-eval.test.ts
//
// Offline check of the golden question set in evals/golden/loadout.jsonl.
// No model is called. The test checks that every line parses and has the
// required fields, that ids are unique, that paraphrases are string arrays,
// and that each required fact appears in the Loadout corpus. Cases whose fact
// is missing from the corpus are printed for review; the test fails only when
// more than MAX_NEEDS_REVIEW cases need review. It also checks the offline
// classifier used by the live runner (classifyResult in golden-eval.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyResult } from "./golden-eval.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const goldenPath = join(repoRoot, "evals", "golden", "loadout.jsonl");
const corpusDir = join(repoRoot, "loadout", "corpus");

const MAX_NEEDS_REVIEW = 3;
const MIN_CASES = 30;
const VERDICTS = new Set(["CASE1", "CASE2", "SILENT"]);

interface RequiredFact {
  text: string;
  mustAppearIn?: string;
}

interface GoldenCase {
  id: string;
  question: string;
  paraphrases: unknown;
  requiredFacts: RequiredFact[];
  forbiddenClaims?: unknown;
  expect: string;
  expectedSource?: string | null;
  note?: string;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function loadCorpus(): string {
  const parts = readdirSync(corpusDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFileSync(join(corpusDir, name), "utf8"));
  return normalise(parts.join("\n"));
}

function loadCases(): { cases: GoldenCase[]; errors: string[] } {
  const cases: GoldenCase[] = [];
  const errors: string[] = [];
  const lines = readFileSync(goldenPath, "utf8").split(/\r?\n/);

  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `line ${index + 1}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      errors.push(`${where}: not valid JSON (${(err as Error).message})`);
      return;
    }

    for (const field of ["id", "question", "expect", "requiredFacts"]) {
      if (!(field in parsed)) errors.push(`${where}: missing "${field}"`);
    }
    if (typeof parsed.id !== "string") errors.push(`${where}: "id" must be a string`);
    if (typeof parsed.question !== "string") errors.push(`${where}: "question" must be a string`);
    if (typeof parsed.expect !== "string" || !VERDICTS.has(parsed.expect)) {
      errors.push(`${where}: "expect" must be CASE1, CASE2 or SILENT`);
    }
    if (!Array.isArray(parsed.requiredFacts)) {
      errors.push(`${where}: "requiredFacts" must be an array`);
    } else {
      parsed.requiredFacts.forEach((fact, i) => {
        if (typeof fact !== "object" || fact === null || typeof (fact as RequiredFact).text !== "string") {
          errors.push(`${where}: requiredFacts[${i}] needs a string "text"`);
        }
      });
    }
    if (parsed.forbiddenClaims !== undefined) {
      if (!Array.isArray(parsed.forbiddenClaims) || !parsed.forbiddenClaims.every((s) => typeof s === "string")) {
        errors.push(`${where}: "forbiddenClaims" must be an array of strings`);
      }
    }

    cases.push(parsed as unknown as GoldenCase);
  });

  return { cases, errors };
}

test("every line is valid JSON with id, question, expect and requiredFacts", () => {
  const { cases, errors } = loadCases();
  assert.deepEqual(errors, []);
  assert.ok(cases.length >= MIN_CASES, `expected at least ${MIN_CASES} cases, found ${cases.length}`);
});

test("ids are unique", () => {
  const { cases } = loadCases();
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const c of cases) {
    if (seen.has(c.id)) dupes.push(c.id);
    seen.add(c.id);
  }
  assert.deepEqual(dupes, []);
});

test("every paraphrase array is an array of strings", () => {
  const { cases } = loadCases();
  for (const c of cases) {
    assert.ok(Array.isArray(c.paraphrases), `${c.id}: paraphrases must be an array`);
    for (const p of c.paraphrases as unknown[]) {
      assert.equal(typeof p, "string", `${c.id}: every paraphrase must be a string`);
    }
  }
});

test("required facts appear in the Loadout corpus (at most 3 cases need review)", () => {
  const { cases } = loadCases();
  const corpus = loadCorpus();
  const needsReview: { id: string; missing: string[] }[] = [];

  for (const c of cases) {
    const missing = c.requiredFacts
      .map((fact) => fact.text)
      .filter((text) => !corpus.includes(normalise(text)));
    if (missing.length > 0) needsReview.push({ id: c.id, missing });
  }

  if (needsReview.length > 0) {
    console.log(`golden-eval: ${needsReview.length} case(s) need review (fact not found in corpus):`);
    for (const row of needsReview) {
      console.log(`  - ${row.id}: ${row.missing.map((m) => JSON.stringify(m)).join(", ")}`);
    }
  } else {
    console.log("golden-eval: all required facts found in the corpus");
  }

  assert.ok(
    needsReview.length <= MAX_NEEDS_REVIEW,
    `${needsReview.length} cases need review; the limit is ${MAX_NEEDS_REVIEW}`,
  );
});

test("classifyResult: an answer with a source and text is CASE1", () => {
  assert.equal(classifyResult({ answer: "You Ship, We Ship.", source: "07-faq.md" }), "CASE1");
});

test("classifyResult: no source, source NONE, or text UNCLEAR is CASE2", () => {
  assert.equal(classifyResult({ answer: "I cannot confirm that.", source: null }), "CASE2");
  assert.equal(classifyResult({ answer: "I cannot confirm that.", source: "NONE" }), "CASE2");
  assert.equal(classifyResult({ answer: "UNCLEAR", source: "07-faq.md" }), "CASE2");
});

test("classifyResult: a silent flag is SILENT", () => {
  assert.equal(classifyResult({ answer: "", source: null, silent: true }), "SILENT");
});
