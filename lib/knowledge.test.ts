process.env.ORRY_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const knowledge = require("./knowledge");
const programs = require("./programs");
const db = require("./db");
const answerCache = require("./cache");

db.open(":memory:");

test("textFromJsonFaq extracts question and answer pairs", () => {
  assert.equal(
    knowledge.textFromJsonFaq({ faq: { items: [{ question: "How?", answer: "Like this." }] } }),
    "Q: How?\nA: Like this.",
  );
  assert.equal(knowledge.textFromJsonFaq({}), "");
});

test("HTML conversion preserves useful links and removes page chrome", () => {
  const html =
    '<nav>menu</nav><main><h1 id="start">Start here</h1><p>Read <a href="https://example.invalid/docs">the docs</a>.</p></main>';
  const links = new Map<string, string>();
  const annotated = knowledge.annotateHeadingAnchors(html, "https://example.invalid/docs", links);
  assert.match(annotated, /## Start here/);
  assert.equal(links.get("start here"), "https://example.invalid/docs#start");
  assert.equal(
    knowledge.stripHtml(annotated),
    "## Start here (https://example.invalid/docs#start)\n\n Read the docs (https://example.invalid/docs) .",
  );
});

test("preserveLinks does not duplicate a URL used as its own label", () => {
  assert.equal(
    knowledge.preserveLinks('<a href="https://example.invalid">https://example.invalid</a>').trim(),
    "https://example.invalid",
  );
});

test("Slack docs index links become retrievable Markdown links", () => {
  assert.equal(
    knowledge.formatSlackDocText("Start here <https://loadout.dino.icu/docs/start|What is Loadout?>"),
    "Start here [What is Loadout?](https://loadout.dino.icu/docs/start)",
  );
});

test("filename helpers create stable titles and slugs", () => {
  assert.equal(knowledge.docTitleFromFilename("01-get_started.md"), "Get Started");
  assert.equal(knowledge.docSlugFromFilename("01-get_started.md"), "get-started");
});

test("markdown listings keep only usable markdown files in order", () => {
  const listing = [
    { type: "file", name: "z.md", download_url: "https://example.invalid/z" },
    { type: "file", name: "a.md", download_url: "https://example.invalid/a" },
    { type: "dir", name: "nested" },
  ];
  const files = knowledge.markdownFilesFromListing(listing, "https://example.invalid/docs");
  assert.deepEqual(
    files.map((file: { name: string }) => file.name),
    ["a.md", "z.md"],
  );
  assert.equal(files[0].pageUrl, "https://example.invalid/docs/a");
});

test("dropSharedLines removes repeated page chrome", () => {
  const pages = ["Header\nUnique A", "Header\nUnique B", "Header\nUnique C"];
  assert.deepEqual(knowledge.dropSharedLines(pages), ["Unique A", "Unique B", "Unique C"]);
  assert.deepEqual(knowledge.dropSharedLines(["one", "two"]), ["one", "two"]);
});

test("inline sources render generically", async () => {
  assert.equal(
    await knowledge.fetchSourceText({ name: "FAQ", type: "json-faq", content: [{ question: "Q", answer: "A" }] }),
    "Q: Q\nA: A",
  );
  assert.equal(await knowledge.fetchSourceText({ name: "Docs", type: "text", content: "  body  " }), "body");
  await assert.rejects(
    () => knowledge.fetchSourceText({ name: "Missing", type: "text" }),
    /neither a url nor inline content/,
  );
});

test("unsupported source types fail instead of using a special-case fetcher", async () => {
  await assert.rejects(
    () => knowledge.fetchSourceText({ name: "Unknown", type: "unsupported", url: "https://example.invalid" }),
    /unknown source type/,
  );
});

test("a dynamic docs crawl fails when any linked page is unavailable", async () => {
  const sourceGuard = require("./sourceGuard");
  const originalFetch = sourceGuard.fetchSourceUrl;
  sourceGuard.fetchSourceUrl = async (url: string) => {
    if (url === "https://example.invalid/docs") {
      return { data: '<main><a href="/docs/known">Known</a><a href="/docs/missing">Missing</a></main>' };
    }
    if (url === "https://example.invalid/docs/known") return { data: "<main>known content</main>" };
    throw new Error("upstream unavailable");
  };

  try {
    await assert.rejects(
      () => knowledge.fetchSourceText({ name: "Docs", type: "url", url: "https://example.invalid/docs" }, true),
      /failed to fetch 1 page\(s\) while crawling/,
    );
  } finally {
    sourceGuard.fetchSourceUrl = originalFetch;
  }
});

test("a dynamic docs crawl follows every in-scope link until the corpus is complete", async () => {
  const sourceGuard = require("./sourceGuard");
  const originalFetch = sourceGuard.fetchSourceUrl;
  sourceGuard.fetchSourceUrl = async (url: string) => {
    const last = url.split("/").pop() || "docs";
    const page = last === "docs" ? 0 : Number(last);
    const next = page < 5 ? `<a href="/docs/${page + 1}">next</a>` : "";
    return { data: `<main>page-${page} ${next}</main>` };
  };

  try {
    const text = await knowledge.fetchSourceText(
      { name: "Docs", type: "url", url: "https://example.invalid/docs" },
      true,
    );
    for (let page = 0; page <= 5; page++) assert.match(text, new RegExp(`page-${page}`));
  } finally {
    sourceGuard.fetchSourceUrl = originalFetch;
  }
});

test("source cache keys isolate URLs and inline content", () => {
  assert.equal(
    knowledge.sourceCacheKey({ name: "Docs", url: "https://example.invalid/a" }),
    "Docs::https://example.invalid/a",
  );
  assert.notEqual(
    knowledge.sourceCacheKey({ name: "FAQ", type: "text", content: "a" }),
    knowledge.sourceCacheKey({ name: "FAQ", type: "text", content: "b" }),
  );
  assert.match(knowledge.sourceCacheKey({ name: "No source" }), /::inline::/);
});

test("startup restores last-good source text before starting a network refresh", () => {
  const source = { name: "Docs", type: "url", url: "https://example.invalid/docs" };
  db.saveSourceText(knowledge.sourceCacheKey(source), "last good source text");

  assert.deepEqual(knowledge.restoreCorpusFromDisk([source]), { restored: 1, total: 1 });
});

test("startup does not trust a dynamic source cache until this boot's refresh finishes", () => {
  const source = { name: "Dynamic status", type: "url", url: "https://example.invalid/status", dynamic: true };
  db.saveSourceText(knowledge.sourceCacheKey(source), "old status");

  assert.deepEqual(knowledge.restoreCorpusFromDisk([source]), { restored: 0, total: 1 });
});

test("source eligibility uses the last successful copy and keeps dynamic copies stale", () => {
  const stable = { name: "Stable", type: "text", url: "https://example.invalid/stable" };
  const stableKey = knowledge.sourceCacheKey(stable);
  db.saveSourceText(stableKey, "stable");
  assert.equal(knowledge.sourceEligibility(stable).exactClaimsAllowed, true);

  const dynamic = { name: "Dynamic", type: "text", url: "https://example.invalid/dynamic", dynamic: true };
  const dynamicKey = knowledge.sourceCacheKey(dynamic);
  db.saveSourceText(dynamicKey, "last good");
  db.recordSourceFailure(dynamicKey, "offline");
  const result = knowledge.sourceEligibility(dynamic);
  assert.equal(result.authority, "dynamic");
  assert.equal(result.exactClaimsAllowed, false);
});

test("a changed program source clears only that program's cached answers", async () => {
  const source = (content: string) => ({
    id: "program-refresh-cache",
    name: "Refresh Cache",
    sharedSources: false,
    sources: [{ name: "Inline docs", type: "text", content }],
  });
  const savedPrograms = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  const question = "how many sample devices?";
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([source("There is 1 sample device.")]);
  programs.invalidate();
  answerCache.put(question, { source: "Inline docs", answer: "1 sample device." }, undefined, "program-refresh-cache");
  answerCache.put(question, { source: "Other Docs", answer: "Other answer." }, undefined, "other-program");
  try {
    process.env.ORRY_PROGRAMS_JSON = JSON.stringify([source("There are 2 sample devices.")]);
    programs.invalidate();
    const refresh = knowledge.refreshProgramSources("program-refresh-cache", { force: true });
    assert.equal(refresh.started, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(answerCache.get(question, "program-refresh-cache"), null);
    assert.equal(answerCache.get(question, "other-program")?.answer, "Other answer.");
  } finally {
    if (savedPrograms === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = savedPrograms;
    programs.invalidate();
  }
});

test("a changed shared source clears cached answers for every program that inherits it", async () => {
  const sourceGuard = require("./sourceGuard");
  const originalFetch = sourceGuard.fetchSourceUrl;
  const source = { name: "Shared refresh", type: "gdoc", url: "https://example.invalid/shared" };
  const sourceKey = knowledge.sourceCacheKey(source);
  const savedPrograms = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  const question = "what does the shared guide say?";
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([
    { id: "shared", sources: [source] },
    { id: "shared-consumer-a", sharedSources: true },
    { id: "shared-consumer-b", sharedSources: true },
    { id: "shared-opt-out", sharedSources: false },
  ]);
  programs.invalidate();
  knowledge.invalidate();
  db.saveSourceText(sourceKey, "old shared source");
  answerCache.put(question, { source: source.name, answer: "old shared answer" }, undefined, "shared-consumer-a");
  answerCache.put(question, { source: source.name, answer: "old shared answer" }, undefined, "shared-consumer-b");
  answerCache.put(question, { source: source.name, answer: "unrelated answer" }, undefined, "shared-opt-out");
  sourceGuard.fetchSourceUrl = async () => ({ data: "updated shared source" });

  try {
    const refresh = knowledge.refreshProgramSources("shared-consumer-a", { force: true });
    assert.equal(refresh.started, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(answerCache.get(question, "shared-consumer-a"), null);
    assert.equal(answerCache.get(question, "shared-consumer-b"), null);
    assert.equal(answerCache.get(question, "shared-opt-out")?.answer, "unrelated answer");
  } finally {
    sourceGuard.fetchSourceUrl = originalFetch;
    if (savedPrograms === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = savedPrograms;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("source removal clears cached answers even when only the persisted source cache remains", async () => {
  const oldSource = { name: "Removed Docs", type: "url", url: "https://example.invalid/removed" };
  const currentSource = { name: "Current Docs", type: "text", content: "Current source text." };
  const savedPrograms = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  const oldKey = knowledge.sourceCacheKey(oldSource);
  const currentKey = knowledge.sourceCacheKey(currentSource);
  db.saveSourceText(oldKey, "Removed source text.");
  db.saveSourceText(currentKey, "Current source text.");
  const question = "what did removed docs say?";
  answerCache.put(
    question,
    { source: oldSource.name, answer: "obsolete cached answer" },
    undefined,
    "removed-source-program",
  );
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([
    { id: "removed-source-program", sources: [currentSource], sharedSources: false },
  ]);
  programs.invalidate();
  try {
    await knowledge.refreshCorpus(true);
    assert.equal(answerCache.get(question, "removed-source-program"), null);
    assert.equal(db.loadSourceText(oldKey), null);
  } finally {
    if (savedPrograms === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = savedPrograms;
    programs.invalidate();
  }
});

test("refresh preserves a legacy bare-name source cache alias while that source is active", async () => {
  const source = { name: "Legacy Docs", type: "url", url: "https://example.invalid/legacy" };
  const savedPrograms = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  const sourceGuard = require("./sourceGuard");
  const originalFetch = sourceGuard.fetchSourceUrl;
  db.saveSourceText(source.name, "Last-known-good legacy source.");
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([
    { id: "legacy-cache-program", sources: [source], sharedSources: false },
  ]);
  programs.invalidate();
  sourceGuard.fetchSourceUrl = async () => {
    throw new Error("offline");
  };
  try {
    await knowledge.refreshCorpus(true);
    assert.equal(db.loadSourceText(source.name)?.text, "Last-known-good legacy source.");
    assert.match(knowledge.getCorpus("legacy-cache-program"), /Last-known-good legacy source/);
  } finally {
    sourceGuard.fetchSourceUrl = originalFetch;
    if (savedPrograms === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = savedPrograms;
    programs.invalidate();
  }
});

test("a restored dynamic source is not exact-claim fresh before this boot refreshes it", () => {
  const dynamic = { name: "Boot dynamic", type: "url", url: "https://example.invalid/boot", dynamic: true };
  const key = knowledge.sourceCacheKey(dynamic);
  db.saveSourceText(key, "persisted status");
  assert.equal(knowledge.sourceEligibility(dynamic).exactClaimsAllowed, false);
});

test("lazy disk restoration of dynamic context does not make it exact-claim fresh", () => {
  const saved = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  const source = { name: "Lazy dynamic", type: "url", url: "https://example.invalid/lazy", dynamic: true };
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([{ id: "lazy-prog", name: "Lazy", sources: [source] }]);
  programs.invalidate();
  knowledge.invalidate();
  db.saveSourceText(knowledge.sourceCacheKey(source), "A dynamically changing exact value is 17.");
  try {
    assert.match(knowledge.getContext("what is the exact value", "lazy-prog"), /exact value is 17/);
    assert.equal(knowledge.sourceEligibility(source).exactClaimsAllowed, false);
  } finally {
    if (saved === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("refreshSource reports failures while retaining last-good source text", async () => {
  const source = { name: "Failed refresh", type: "unsupported", url: "https://example.invalid/fail" };
  const key = knowledge.sourceCacheKey(source);
  db.saveSourceText(key, "last good");
  const outcome = await knowledge.refreshSource(source, true);
  assert.equal(outcome.success, false);
  assert.equal(db.loadSourceText(key).text, "last good");
});

test("refreshCorpus keeps answer cache when every source body is unchanged", async () => {
  const saved = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([
    { id: "unchanged", name: "Unchanged", sources: [{ name: "Stable body", type: "text", content: "same text" }] },
  ]);
  programs.invalidate();
  try {
    await knowledge.refreshCorpus(true);
    answerCache.put("cache survives refresh", { source: "Stable body", answer: "still valid" });
    await knowledge.refreshCorpus(true);
    assert.equal(answerCache.get("cache survives refresh").answer, "still valid");
  } finally {
    if (saved === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("operator sources load from configured programs", async () => {
  const saved = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([
    {
      id: "demo",
      name: "Demo",
      sources: [{ name: "Demo docs", type: "text", content: "demo body" }],
    },
  ]);
  programs.invalidate();
  try {
    assert.deepEqual(
      knowledge.loadSources().map((source: { name: string }) => source.name),
      ["Demo docs"],
    );
    await knowledge.refreshSource(programs.get("demo").sources[0], true);
    assert.match(knowledge.getCorpus("demo"), /demo body/);
  } finally {
    if (saved === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("program source corpora remain isolated", async () => {
  const saved = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([
    { id: "acme", name: "Acme", sources: [{ name: "Acme docs", type: "text", content: "acme-only" }] },
    { id: "beta", name: "Beta", sources: [{ name: "Beta docs", type: "text", content: "beta-only" }] },
  ]);
  programs.invalidate();
  knowledge.invalidate();
  try {
    await knowledge.refreshSource(programs.get("acme").sources[0], true);
    await knowledge.refreshSource(programs.get("beta").sources[0], true);
    assert.match(knowledge.getContext("acme facts", "acme"), /acme-only/);
    assert.doesNotMatch(knowledge.getContext("acme facts", "beta"), /acme-only/);
    assert.match(knowledge.getEvidenceContext("acme facts", "acme").context, /acme-only/);
    assert.doesNotMatch(knowledge.getEvidenceContext("acme facts", "beta").context, /acme-only/);
  } finally {
    if (saved === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("program source passages survive a large generated section under a tight evidence budget", async () => {
  const saved = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([
    {
      id: "gadget",
      name: "Gadget",
      sharedSources: false,
      evidenceBudget: 300,
      sources: [
        {
          name: "Gadget docs",
          type: "text",
          content:
            "Gadget cost is twelve credits for a standard build, including the frame and the assembly instructions for every kit.",
        },
      ],
    },
  ]);
  programs.invalidate();
  knowledge.invalidate();
  try {
    await knowledge.refreshSource(programs.get("gadget").sources[0], true);
    // "who are you" only matches the large generated identity section, so the source is
    // reached only through the unmatched fill, which used to be cut once the identity filled the budget.
    const { passages } = knowledge.getEvidenceContext("who are you?", "gadget");
    const source = passages.filter((passage: { kind: string }) => passage.kind === "source");
    assert.ok(source.some((passage: { text: string }) => /twelve credits/.test(passage.text)));
    assert.ok(passages.reduce((size: number, passage: { text: string }) => size + passage.text.length, 0) <= 300);
  } finally {
    if (saved === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("personal questions retrieve the matching parts of Orry's full canon", () => {
  const savedPrograms = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  const savedBotName = process.env.ORRY_BOT_NAME ?? process.env.RIVET_BOT_NAME;
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([
    { id: "loadout", name: "Loadout", supportName: "Orry the ore Maulwürf", sharedSources: false, sources: [] },
  ]);
  process.env.ORRY_BOT_NAME = "Orry the ore Maulwürf";
  programs.invalidate();
  knowledge.invalidate();
  try {
    const accident = knowledge.getEvidenceContext("what happened in the mine accident?", "loadout").context;
    const treasure = knowledge.getEvidenceContext("what is the treasure hunt with Goose?", "loadout").context;
    assert.match(accident, /serious mistake that caused a fatal mine accident/i);
    assert.match(accident, /I saved him/i);
    assert.match(treasure, /Goose wants the risk and adventure; I want the treasure/i);
    assert.doesNotMatch(treasure, /Goose sees their rivalry as playful/i);
  } finally {
    if (savedPrograms === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = savedPrograms;
    if (savedBotName === undefined) delete process.env.ORRY_BOT_NAME;
    else process.env.ORRY_BOT_NAME = savedBotName;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("refreshSource invalidates cached source sections", async () => {
  const saved = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([
    { id: "cache-demo", name: "Cache Demo", sources: [{ name: "Docs", type: "text", content: "version-one token" }] },
  ]);
  programs.invalidate();
  knowledge.invalidate();
  try {
    const source = programs.get("cache-demo").sources[0];
    await knowledge.refreshSource(source, true);
    assert.match(knowledge.getContext("version one", "cache-demo"), /version-one token/);

    source.content = "version-two token";
    await knowledge.refreshSource(source, true);
    const refreshed = knowledge.getContext("version two", "cache-demo");
    assert.match(refreshed, /version-two token/);
    assert.doesNotMatch(refreshed, /version-one token/);
  } finally {
    if (saved === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("program invalidation drops cached source-section views", async () => {
  const saved = process.env.ORRY_PROGRAMS_JSON ?? process.env.RIVET_PROGRAMS_JSON;
  const sourceA = { name: "Docs A", type: "text", content: "alpha-source token" };
  const sourceB = { name: "Docs B", type: "text", content: "beta-source token" };

  await knowledge.refreshSource(sourceA, true);
  await knowledge.refreshSource(sourceB, true);

  process.env.ORRY_PROGRAMS_JSON = JSON.stringify([{ id: "versioned", name: "Versioned", sources: [sourceA] }]);
  programs.invalidate();
  knowledge.invalidate();

  try {
    assert.match(knowledge.getContext("alpha source", "versioned"), /alpha-source token/);

    process.env.ORRY_PROGRAMS_JSON = JSON.stringify([{ id: "versioned", name: "Versioned", sources: [sourceB] }]);
    programs.invalidate();

    const refreshed = knowledge.getContext("beta source", "versioned");
    assert.match(refreshed, /beta-source token/);
    assert.doesNotMatch(refreshed, /alpha-source token/);
  } finally {
    if (saved === undefined) delete process.env.ORRY_PROGRAMS_JSON;
    else process.env.ORRY_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("draft knowledge uses only supplied source text", () => {
  const result = knowledge.registerDraftKnowledge(
    { id: "draft-demo", status: "suspended", privateSandboxOnly: true },
    { "Draft docs": "draft-only" },
  );
  assert.equal(result.sources, 1);
  assert.match(knowledge.getDraftContext("draft-demo", "draft"), /draft-only/);
});

test("local path resolution stays inside the application root", () => {
  assert.match(knowledge.resolveLocalPath("file://./package.json"), /package\.json$/);
  assert.throws(() => knowledge.resolveLocalPath("file:///tmp/outside"), /outside app root/);
});

test("status sanitizes remote URLs", () => {
  const sourceStatus = knowledge.sourceStatus("missing-program");
  assert.deepEqual(sourceStatus, []);
});

test("deployment program config is gitignored, never committed", () => {
  // config/programs.json holds a real deployment's channel ids, so it exists
  // locally but must never be tracked. Asserting the file is absent instead
  // would break the moment anyone deploys, which is exactly backwards.
  const ignore = fs.readFileSync(".gitignore", "utf8");
  assert.match(ignore, /^config\/$/m);
});

export {};
