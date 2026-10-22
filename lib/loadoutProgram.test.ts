import { test, expect } from "bun:test";
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "loadout", "program.json");

interface LoadoutSource {
  name: string;
  type?: string;
  url?: string;
}

interface LoadoutProgram {
  id: string;
  scope?: string;
  supportName?: string;
  replySignature?: string;
  channels?: string[];
  helpChannel?: string;
  sources: LoadoutSource[];
  pinnedRules: string[];
  evidenceBudget?: number;
}

function loadout(): LoadoutProgram {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as LoadoutProgram;
}

test("every LOADOUT source points at a file that exists", () => {
  const missing = loadout()
    .sources.filter((s) => (s.url || "").startsWith("file://"))
    .map((s) => ({ name: s.name, path: s.url!.replace("file://", "") }))
    .filter((s) => !fs.existsSync(path.join(ROOT, s.path)));
  expect(missing).toEqual([]);
});

test("every LOADOUT source is a named markdown file inside the repo", () => {
  for (const source of loadout().sources) {
    expect(source.name).toBeTruthy();
    expect(source.type).toBe("markdown");
    expect(source.url!.startsWith("file://loadout/corpus/")).toBe(true);
  }
});

test("the Loadout evidence budget covers the whole program corpus", () => {
  const program = loadout();
  const corpusBytes = program.sources
    .filter((s) => (s.url || "").startsWith("file://"))
    .reduce((sum, s) => sum + fs.statSync(path.join(ROOT, s.url!.replace("file://", ""))).size, 0);
  expect(program.evidenceBudget ?? 0).toBeGreaterThanOrEqual(corpusBytes);
});

test("the not-verified page is a source and the pinned rule points at it", () => {
  const program = loadout();
  expect(program.sources.some((s) => s.url === "file://loadout/corpus/11-unverified.md")).toBe(true);
  expect(program.pinnedRules.some((r) => /not verified yet/i.test(r))).toBe(true);
});

test("the LOADOUT program claims explicit Slack channels", () => {
  const program = loadout();
  expect(program.scope).toBe("program");
  expect(program.channels?.length ?? 0).toBeGreaterThan(0);
  for (const channel of program.channels ?? []) expect(channel).toMatch(/^C[A-Z0-9]+$/);
});

test("Loadout splits ambient and help channels: #loadout is main, #loadout-help files tickets", () => {
  const program = loadout();
  expect(program.channels ?? []).toEqual(["C0C5XUDMRH9"]);
  expect(program.helpChannel).toBe("C0C6XBLM0M7");
  expect(program.channels ?? []).not.toContain(program.helpChannel);
});

test("LOADOUT pins the canonical economy rules that the corpus is graded on", () => {
  const rules = loadout().pinnedRules.join("\n");
  expect(rules).toContain("Bolts");
  expect(rules).toContain("Tools");
  expect(rules).toContain("LV.15");
  expect(rules).toContain("Research Mode is a modifier");
});

test("the bot displays as Orry and signs nothing", () => {
  const program = loadout();
  expect(program.supportName).toBe("Orry");
  expect(program.replySignature || "").toBe("");
});

test("the pinned rules name the makers and the casing rules", () => {
  const rules = loadout().pinnedRules.join("\n");
  for (const maker of ["Netic", "Wind", "Jerry"]) expect(rules).toContain(maker);
  expect(rules).toContain("'Loadout', never 'LOADOUT'");
  expect(rules).toContain("'YSWS'");
});

test("the makers and their org role are stated in prose, not only in rules", () => {
  const corpus = fs.readFileSync(path.join(ROOT, "loadout", "corpus", "06-timeline.md"), "utf8");
  expect(corpus).toContain("Netic, Wind, and Jerry");
  expect(corpus).toContain("also the org");
});

test("the corpus states the canonical tracks and level cap in prose, not only in config", () => {
  const corpus = fs.readFileSync(path.join(ROOT, "loadout", "corpus", "02-tracks.md"), "utf8");
  for (const track of ["Tools", "Systems", "Compute", "Hardware"]) expect(corpus).toContain(track);
  expect(corpus).toContain("LV.15");
  expect(corpus).toContain("not a fifth track");
});

test("the FAQ defines the YSWS acronym for short ambient questions", () => {
  const faq = fs.readFileSync(path.join(ROOT, "loadout", "corpus", "07-faq.md"), "utf8");
  expect(faq).toContain('YSWS means "You Ship, We Ship"');
});

test("the corpus never reintroduces the superseded Cores model", () => {
  const corpusDir = path.join(ROOT, "loadout", "corpus");
  const offenders = fs
    .readdirSync(corpusDir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => /\bcores?\b/i.test(fs.readFileSync(path.join(corpusDir, f), "utf8")));
  expect(offenders).toEqual([]);
});

test("the corpus never claims a fifth track or a per-3-level coupon", () => {
  const corpusDir = path.join(ROOT, "loadout", "corpus");
  const offenders = fs
    .readdirSync(corpusDir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => /every 3 levels|25% reduction/i.test(fs.readFileSync(path.join(corpusDir, f), "utf8")));
  expect(offenders).toEqual([]);
});
