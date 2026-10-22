// Run with: bun test scripts/doctor.test.ts
//
// The doctor is exercised through an injected env + filesystem seam, so every
// case is deterministic and no real .env or corpus file is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runDoctor,
  render,
  resolveSourcePath,
  checkRequiredEnv,
  checkCorpusFiles,
  checkChannelRoles,
  loadConfiguredPrograms,
} from "./doctor.mjs";

const SECRET = "s3cr3t-do-not-print";

// Every value that must never reach the report, keyed by the variable it
// stands in for.
const SECRET_VALUES = [
  "xoxb-" + SECRET,
  "xapp-" + SECRET,
  SECRET,
  "sk-" + SECRET,
];

const COMPLETE_ENV = {
  OPENCODE_API_KEY: "sk-" + SECRET,
  SLACK_BOT_TOKEN: "xoxb-" + SECRET,
  SLACK_APP_TOKEN: "xapp-" + SECRET,
  SLACK_HELP_CHANNEL: "C0HELP0001",
  SLACK_FAQ_CHANNELS: "C0HELP0001",
  ORRY_DASHBOARD_PASSCODE: "correct-horse-" + SECRET,
  SLACK_CLIENT_ID: "1234567890.9876543210",
};

interface Seam {
  env: Record<string, string | undefined>;
  files?: string[];
  /** config/programs.json contents, or null when the file is absent. */
  programsFile?: string | null;
}

function deps({ env, files = [], programsFile = null }: Seam) {
  const present = new Set(files.map((f) => resolveSourcePath(f)));
  return {
    env,
    fileExists: (target: string) => present.has(target),
    readFile: (target: string) => (target.endsWith("programs.json") ? programsFile : null),
  };
}

function report(overrides: Partial<Seam> & { env?: Record<string, string | undefined> } = {}) {
  return runDoctor(deps({ env: COMPLETE_ENV, ...overrides } as Seam));
}

function lineFor(report_: ReturnType<typeof report>, name: string) {
  const check = report_.checks.find((c: { name: string }) => c.name === name);
  assert.ok(check, `no check named "${name}"`);
  return check;
}

test("a complete, healthy configuration passes every check", () => {
  const r = report({
    env: {
      ...COMPLETE_ENV,
      ORRY_PROGRAMS_JSON: JSON.stringify([
        {
          id: "acme",
          name: "Acme",
          channels: ["C0HELP0001"],
          helpChannel: "C0HELP0001",
          sources: [
            { name: "handbook", type: "markdown", url: "file://loadout/corpus/01-program.md" },
            { name: "faq", type: "markdown", url: "file://loadout/corpus/07-faq.md" },
            { name: "site", type: "url", url: "https://example.com/docs" },
          ],
        },
      ]),
    },
    files: ["loadout/corpus/01-program.md", "loadout/corpus/07-faq.md"],
  });

  // channel roles is excluded: it reads the engine's own program database and
  // config file rather than this env seam, so it is asserted separately above.
  const controlled = r.checks.filter((c) => c.name !== "channel roles");
  assert.equal(
    controlled.filter((c) => c.status === "fail").length,
    0,
    render(r),
  );
  assert.equal(
    controlled.filter((c) => c.status === "warn").length,
    0,
    render(r),
  );
});

test("the report includes a channel-role check, the one the engine refuses to boot on", () => {
  // Deliberately not asserting pass/fail parity: this check runs the real
  // lib/channelPolicy validator, which also reads the program database and
  // config/programs.json, so its verdict depends on engine state a unit test
  // cannot stub. What must hold is that the check exists and is wired in —
  // its absence is what let --doctor go green while the bot crash-looped.
  const r = report({ env: COMPLETE_ENV, files: [] });
  assert.ok(
    r.checks.some((c) => c.name === "channel roles"),
    "report is missing the channel roles check",
  );
  assert.ok(r.checks.every((c) => ["pass", "fail", "warn"].includes(c.status)));
});

test("a program that claims no channel warns, because it can never answer", () => {
  const r = report({
    env: { ...COMPLETE_ENV, ORRY_PROGRAMS_JSON: JSON.stringify([{ id: "acme", name: "Acme", sources: [] }]) },
    files: [],
  });

  const check = lineFor(r, "claimed channels");
  assert.equal(check.status, "warn");
  assert.match(check.detail, /acme/);
  assert.match(check.detail, /answer nothing anywhere/);
});

test("a program claiming only a helpChannel counts as claimed", () => {
  const r = report({
    env: {
      ...COMPLETE_ENV,
      ORRY_PROGRAMS_JSON: JSON.stringify([{ id: "acme", helpChannel: "C0HELP0001", sources: [] }]),
    },
    files: [],
  });

  assert.equal(lineFor(r, "claimed channels").status, "pass");
});

test("a missing required variable fails and is named, never valued", () => {
  const env: Record<string, string | undefined> = { ...COMPLETE_ENV };
  delete env.SLACK_FAQ_CHANNELS;
  const r = report({ env });

  const check = lineFor(r, "required env vars");
  assert.equal(check.status, "fail");
  assert.ok(check.detail.includes("SLACK_FAQ_CHANNELS"), check.detail);
  assert.ok(!check.detail.includes("SLACK_BOT_TOKEN"), "should not list vars that are present");
});

test("doctor identifies the Pixl HTTP signing secret in Orry's Socket Mode token field", () => {
  const r = report({ env: { ...COMPLETE_ENV, SLACK_APP_TOKEN: "signing-secret" } });
  const check = r.checks.find((c) => c.name === "Slack token formats");
  assert.ok(check, "report should validate Socket Mode token formats");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /SLACK_APP_TOKEN.*xapp-/);
  assert.doesNotMatch(check.detail, /signing-secret/);
});

test("doctor warns when FAQ channels are not claimed by a configured program", () => {
  const r = report({
    env: {
      ...COMPLETE_ENV,
      ORRY_PROGRAMS_JSON: JSON.stringify([{ id: "loadout", channels: ["C0LOADOUT"], sources: [] }]),
    },
    files: [],
  });
  const check = r.checks.find((c) => c.name === "FAQ channel ownership");
  assert.ok(check, "report should verify that FAQ channels resolve to configured programs");
  assert.equal(check.status, "warn");
  assert.match(check.detail, /C0HELP0001/);
  assert.match(check.detail, /shared/);
});

test("every required variable is reported when the env is empty", () => {
  const check = checkRequiredEnv({});
  assert.equal(check.status, "fail");
  for (const name of [
    "OPENCODE_API_KEY",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_FAQ_CHANNELS",
  ]) {
    assert.ok(check.detail.includes(name), `${name} missing from: ${check.detail}`);
  }
});

test("a whitespace-only variable counts as missing, as validate() treats it", () => {
  const check = checkRequiredEnv({ ...COMPLETE_ENV, SLACK_FAQ_CHANNELS: "   " });
  assert.equal(check.status, "fail");
  assert.ok(check.detail.includes("SLACK_FAQ_CHANNELS"));
});

test("an absent SLACK_HELP_CHANNEL is fine - every channel runs in normal mode", () => {
  const env = { ...COMPLETE_ENV };
  delete env.SLACK_HELP_CHANNEL;
  const check = checkRequiredEnv(env);
  assert.equal(check.status, "pass");
  assert.ok(!check.detail.includes("SLACK_HELP_CHANNEL"));
});

test("a renamed corpus file is a failure naming the path", () => {
  const r = report({
    env: {
      ...COMPLETE_ENV,
      ORRY_PROGRAMS_JSON: JSON.stringify([
        {
          id: "acme",
          sources: [
            { name: "handbook", url: "file://loadout/corpus/01-program.md" },
            { name: "faq", url: "file://loadout/corpus/07-faq.md" },
          ],
        },
      ]),
    },
    files: ["loadout/corpus/01-program.md"], // 07-faq.md was renamed away
  });

  const check = lineFor(r, "corpus files");
  assert.equal(check.status, "fail");
  assert.ok(check.detail.includes("loadout/corpus/07-faq.md"), check.detail);
  assert.ok(check.detail.includes("acme"), check.detail);
  // Exactly one failure is attributable to this seam; channel roles reads
  // engine state this seam does not control.
  const controlled = r.checks.filter((c) => c.name !== "channel roles");
  assert.equal(controlled.filter((c) => c.status === "fail").length, 1);
});

test("a file:// source outside the app root fails instead of being read", () => {
  const loaded = loadConfiguredPrograms({
    env: {
      ORRY_PROGRAMS_JSON: JSON.stringify([
        { id: "acme", sources: [{ name: "elsewhere", url: "file://../../../etc/passwd" }] },
      ]),
    },
    readFile: () => null,
  });

  const check = checkCorpusFiles(loaded, { fileExists: () => true });
  assert.equal(check.status, "fail");
  assert.ok(check.detail.includes("outside the app root"), check.detail);
});

test("the default dashboard passcode warns, a custom one passes, unset warns", () => {
  const missing = lineFor(report({ env: { ...COMPLETE_ENV, ORRY_DASHBOARD_PASSCODE: undefined } }), "dashboard passcode");
  assert.equal(missing.status, "warn");

  const fallback = lineFor(report({ env: { ...COMPLETE_ENV, ORRY_DASHBOARD_PASSCODE: "rivet" } }), "dashboard passcode");
  assert.equal(fallback.status, "warn");
  assert.ok(fallback.detail.includes("default"));

  const custom = lineFor(report(), "dashboard passcode");
  assert.equal(custom.status, "pass");
});

test("a configured program is reported, none at all warns", () => {
  const none = lineFor(report(), "program config");
  assert.equal(none.status, "warn");
  assert.ok(none.detail.includes("no program configured"));

  const configured = lineFor(
    report({ env: { ...COMPLETE_ENV, ORRY_PROGRAMS_JSON: JSON.stringify([{ id: "acme", name: "Acme" }]) } }),
    "program config",
  );
  assert.equal(configured.status, "pass");
  assert.ok(configured.detail.includes("1 program(s)"));
});

test("the { programs: [...] } shape is accepted, like loadEnvPrograms()", () => {
  const loaded = loadConfiguredPrograms({
    env: { ORRY_PROGRAMS_JSON: JSON.stringify({ programs: [{ id: "acme" }, { id: "beta" }] }) },
    readFile: () => null,
  });
  assert.equal(loaded.error, null);
  assert.equal(loaded.programs.length, 2);
});

test("unparseable program JSON fails the check and explains the fallback", () => {
  const r = report({ env: { ...COMPLETE_ENV, ORRY_PROGRAMS_JSON: "{not json" } });
  const check = lineFor(r, "program config");
  assert.equal(check.status, "fail");
  assert.ok(check.detail.includes("not valid JSON"), check.detail);
});

test("a program config whose shape is wrong fails", () => {
  const check = lineFor(report({ env: { ...COMPLETE_ENV, ORRY_PROGRAMS_JSON: '"just a string"' } }), "program config");
  assert.equal(check.status, "fail");
  assert.ok(check.detail.includes("array"), check.detail);
});

test("the dashboard passcode warns when unset or left at the default", () => {
  const missing = lineFor(
    report({ env: { ...COMPLETE_ENV, ORRY_DASHBOARD_PASSCODE: undefined } }),
    "dashboard passcode",
  );
  assert.equal(missing.status, "warn");
  assert.ok(missing.detail.includes("passcode login is disabled"), missing.detail);

  const fallback = lineFor(report({ env: { ...COMPLETE_ENV, ORRY_DASHBOARD_PASSCODE: "rivet" } }), "dashboard passcode");
  assert.equal(fallback.status, "warn");
  assert.ok(fallback.detail.includes("default"), fallback.detail);

  const custom = lineFor(report(), "dashboard passcode");
  assert.equal(custom.status, "pass");
});

test("config/programs.json is the fallback when the env var is unset", () => {
  const viaFile = lineFor(report({ programsFile: JSON.stringify([{ id: "acme" }]) }), "program config");
  assert.equal(viaFile.status, "pass");
  assert.ok(viaFile.detail.includes("config/programs.json"), viaFile.detail);

  // The env var wins when both exist.
  const both = lineFor(
    report({
      programsFile: JSON.stringify([{ id: "fromfile" }]),
      env: { ...COMPLETE_ENV, ORRY_PROGRAMS_JSON: JSON.stringify([{ id: "fromenv" }]) },
    }),
    "program config",
  );
  assert.ok(both.detail.includes("ORRY_PROGRAMS_JSON"), both.detail);
});

test("the dev-testing client id warns, and says what makes the bypass live", () => {
  const live = lineFor(
    report({ env: { ...COMPLETE_ENV, SLACK_CLIENT_ID: "dev-testing", NODE_ENV: "development" } }),
    "slack oauth client id",
  );
  assert.equal(live.status, "warn");
  assert.ok(live.detail.includes("NODE_ENV=development"), live.detail);
  assert.ok(live.detail.includes("admin"), live.detail);

  // The sentinel alone no longer unlocks anything, so it reads as a placeholder
  // left in place rather than a live bypass.
  const inert = lineFor(report({ env: { ...COMPLETE_ENV, SLACK_CLIENT_ID: "dev-testing" } }), "slack oauth client id");
  assert.equal(inert.status, "warn");
  assert.ok(inert.detail.includes("grants nothing"), inert.detail);

  const real = lineFor(report(), "slack oauth client id");
  assert.equal(real.status, "pass");

  const unset = lineFor(report({ env: { ...COMPLETE_ENV, SLACK_CLIENT_ID: undefined } }), "slack oauth client id");
  assert.equal(unset.status, "pass");
});

test("no secret value is ever printed, in any configuration", () => {
  const brokenProgram = JSON.stringify([
    { id: "acme", sources: [{ name: "gone", url: "file://loadout/corpus/missing.md" }] },
  ]);
  const cases: Seam[] = [
    { env: COMPLETE_ENV },
    { env: COMPLETE_ENV, ORRY_PROGRAMS_JSON: brokenProgram },
    { env: { ...COMPLETE_ENV, ORRY_DASHBOARD_PASSCODE: "rivet" } },
    { env: { ...COMPLETE_ENV, ORRY_DASHBOARD_PASSCODE: undefined } },
    { env: { ...COMPLETE_ENV, SLACK_CLIENT_ID: "dev-testing" } },
    { env: {} },
    { env: { ...COMPLETE_ENV, ORRY_PROGRAMS_JSON: "{not json" } },
    { env: COMPLETE_ENV, programsFile: JSON.stringify([{ id: "acme" }]) },
  ];

  for (const seam of cases) {
    const output = render(report(seam));
    for (const secret of SECRET_VALUES) {
      assert.ok(!output.includes(secret), `secret leaked in:\n${output}`);
    }
    assert.ok(!output.includes("xoxb-"), "a token prefix leaked");
    assert.ok(!output.includes("xapp-"), "an app token prefix leaked");
  }
});

test("every check renders a literal PASS / FAIL / WARN word, not colour", () => {
  const outputs = [
    render(report()),
    render(report({ env: { ...COMPLETE_ENV, ORRY_PROGRAMS_JSON: "{bad" } })),
  ].join("\n");

  assert.ok(outputs.includes("PASS"), outputs);
  assert.ok(outputs.includes("FAIL"), outputs);
  assert.ok(outputs.includes("WARN"), outputs);
  assert.ok(!new RegExp(String.fromCharCode(27)).test(outputs), "no ANSI escapes: signalling must survive plain text");
});

test("the rendered report ends with a one-line verdict carrying the counts", () => {
  const r = report({ env: { ...COMPLETE_ENV, ORRY_PROGRAMS_JSON: "{bad", ORRY_DASHBOARD_PASSCODE: "rivet" } });
  const lines = render(r).trimEnd().split("\n");
  const last = lines[lines.length - 1];

  assert.ok(last.startsWith("Orry will not start as configured:"), last);
  assert.ok(last.includes(`${r.failures} failure${r.failures === 1 ? "" : "s"}`), last);
  assert.ok(last.includes(`${r.warnings} warning${r.warnings === 1 ? "" : "s"}`), last);
  assert.ok(!last.includes("\n"));
});

test("resolveSourcePath strips file:// and roots relative paths at the app root", () => {
  const resolved = resolveSourcePath("file://loadout/corpus/01-program.md");
  assert.ok(resolved.split(/[\\/]/).join("/").endsWith("loadout/corpus/01-program.md"), resolved);
  assert.ok(!resolved.includes("file:"), resolved);
});
