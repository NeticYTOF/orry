const { test } = require("node:test");
const assert = require("node:assert/strict");
const validator = require("./validator");

test("parseGithubUrl parses full GitHub URLs", () => {
  const r1 = validator.parseGithubUrl("https://github.com/hackclub/orry");
  assert.equal(r1.owner, "hackclub");
  assert.equal(r1.repo, "orry");
  assert.equal(r1.fullName, "hackclub/orry");

  const r2 = validator.parseGithubUrl("github.com/torvalds/linux.git");
  assert.equal(r2.owner, "torvalds");
  assert.equal(r2.repo, "linux");

  const r3 = validator.parseGithubUrl("check this out: https://github.com/user/cool-game/tree/main");
  assert.equal(r3.owner, "user");
  assert.equal(r3.repo, "cool-game");
  assert.equal(r3.branch, "main");

  const nestedRef = validator.parseGithubUrl("https://github.com/user/cool-game/tree/feature/release");
  assert.equal(nestedRef.unsupportedTreePath, true);
  const encodedRef = validator.parseGithubUrl("https://github.com/user/cool-game/tree/feature%2Frelease");
  assert.equal(encodedRef.branch, "feature/release");
  assert.equal(encodedRef.unsupportedTreePath, false);
  const describedTreePath = validator.parseGithubUrl(
    "the /tree/unrelated path is discussed here: https://github.com/user/cool-game/tree/main",
  );
  assert.equal(describedTreePath.branch, "main");
  assert.equal(describedTreePath.unsupportedTreePath, false);
});

test("validator refuses an ambiguous tree path instead of checking the wrong ref", async () => {
  let requests = 0;
  const axios = require("axios");
  const originalGet = axios.get;
  axios.get = async () => {
    requests += 1;
    throw new Error("should not make a request for an ambiguous ref");
  };
  try {
    const result = await validator.validateRepository("https://github.com/acme/game/tree/feature/release");
    assert.equal(result.ok, false);
    assert.match(result.error, /nested GitHub tree URL/);
    assert.equal(requests, 0);
  } finally {
    axios.get = originalGet;
  }
});

test("parseGithubUrl returns null for non-github URLs", () => {
  assert.equal(validator.parseGithubUrl("https://gitlab.com/user/repo"), null);
  assert.equal(validator.parseGithubUrl("hello world"), null);
});

test("detectLicense detects standard open source licenses", () => {
  assert.equal(validator.detectLicense("MIT License\n\nPermission is hereby granted..."), "MIT License");
  assert.equal(validator.detectLicense("Apache License, Version 2.0"), "Apache 2.0");
  assert.equal(validator.detectLicense("GNU GENERAL PUBLIC LICENSE Version 3"), "GPL v3");
  assert.equal(validator.detectLicense(""), null);
});

test("analyzeReadme extracts instructions and demo indicators", () => {
  const text = `# My Cool Game
This is a game built for Acme.

## How to Run
\`\`\`bash
npm install
npm run dev
\`\`\`

## Demo
Check out the playable demo at https://play.acme.hackclub.com/
![Screenshot](screenshot.png)
`;
  const res = validator.analyzeReadme(text);
  assert.equal(res.hasReadme, true);
  assert.equal(res.hasInstructions, true);
  assert.equal(res.hasDemo, true);
  assert.equal(res.hasScreenshots, true);
  assert.ok(res.wordCount > 15);
});

test("validator fires only on check-queries with a github URL", () => {
  assert.ok(validator.parseGithubUrl("can you check https://github.com/u/cool-game for submission"));
  assert.equal(validator.parseGithubUrl("how do i submit my project"), null);
});

test("validateRepository uses the repository's default branch instead of assuming main or master", async () => {
  const axios = require("axios");
  const originalGet = axios.get;
  const requested: string[] = [];
  axios.get = async (url: string) => {
    requested.push(url);
    if (url === "https://api.github.com/repos/acme/game") {
      return { status: 200, data: { default_branch: "production" } };
    }
    if (url.endsWith("/production/LICENSE")) {
      return { status: 200, data: "MIT License\nPermission is hereby granted, free of charge" };
    }
    if (url.endsWith("/production/README.md")) {
      return { status: 200, data: "# Game\n\n## How to Run\nnpm run dev\n\n## Demo\nhttps://example.com" };
    }
    throw Object.assign(new Error("missing file"), { response: { status: 404 } });
  };
  try {
    const result = await validator.validateRepository("https://github.com/acme/game");
    assert.equal(result.ok, true);
    assert.equal(result.license.file, "LICENSE");
    assert.equal(result.readme.file, "README.md");
    assert.ok(requested.includes("https://api.github.com/repos/acme/game"));
    assert.ok(requested.some((url) => url.endsWith("/production/README.md")));
    assert.equal(
      requested.some((url) => /\/(?:main|master)\//.test(url)),
      false,
    );
  } finally {
    axios.get = originalGet;
  }
});

test("formatValidationReport degrades on unparseable input", () => {
  assert.match(validator.formatValidationReport({ ok: false, error: "nope" }), /nope/);
  assert.match(validator.formatValidationReport(null), /Could not inspect/);
});
export {};
