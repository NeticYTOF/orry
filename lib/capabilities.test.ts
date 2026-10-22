type TestAny = any;
process.env.ORRY_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("./config");
const brand = require("./brand");
const capabilities = require("./capabilities");

test("capability help exposes public commands and hides helper commands", () => {
  config.slack.adminUserIds = [];
  const help = capabilities.formatHelp({ actorId: "U-random" });

  assert.match(help, /\/orry/);
  assert.match(help, /\/orry-sources/);
  assert.doesNotMatch(help, /\/orry-teach/);
  assert.doesNotMatch(help, /\/orry-reload/);
});

test("capability help exposes helper commands for an admin and follows the slug", () => {
  const previousSlug = (process.env.ORRY_BOT_SLUG ?? process.env.RIVET_BOT_SLUG);
  process.env.ORRY_BOT_SLUG = "sol";
  config.slack.adminUserIds = ["U-admin"];

  try {
    const help = capabilities.formatHelp({ actorId: "U-admin" });
    assert.match(help, /\/sol-teach/);
    assert.match(help, /\/sol-program/);
    assert.doesNotMatch(help, /\/orry-/);
  } finally {
    if (previousSlug === undefined) delete process.env.ORRY_BOT_SLUG;
    else process.env.ORRY_BOT_SLUG = previousSlug;
  }
});

test("registry contains only commands registered by the command module", () => {
  const registered = new Set();
  const commands = require("./commands");
  const app = {
    command: (name: TestAny) => registered.add(name),
    action: () => {},
    shortcut: () => {},
    event: () => {},
    view: () => {},
  };
  commands.register(app);

  for (const capability of capabilities.CAPABILITIES) {
    assert.ok(registered.has(brand.cmd(capability.suffix)), capability.label);
  }
  assert.equal(registered.has(brand.cmd("help")), false);
});
export {};
