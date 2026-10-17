const { test } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("./identity");

function withBrand(name: string | undefined, slug: string | undefined, fn: () => void) {
  const oldName = process.env.RIVET_BOT_NAME;
  const oldSlug = process.env.RIVET_BOT_SLUG;
  if (name === undefined) delete process.env.RIVET_BOT_NAME;
  else process.env.RIVET_BOT_NAME = name;
  if (slug === undefined) delete process.env.RIVET_BOT_SLUG;
  else process.env.RIVET_BOT_SLUG = slug;
  try {
    fn();
  } finally {
    if (oldName === undefined) delete process.env.RIVET_BOT_NAME;
    else process.env.RIVET_BOT_NAME = oldName;
    if (oldSlug === undefined) delete process.env.RIVET_BOT_SLUG;
    else process.env.RIVET_BOT_SLUG = oldSlug;
  }
}

test("default identity is Q/A shaped and describes generic behavior", () => {
  const section = identity.defaultIdentity();
  assert.match(section, /Q: Who are you\?/);
  assert.match(section, /A: I'm Orry the ore Maulwürf/);
  assert.match(section, /learned answers/);
  assert.match(section, /help channel/);
  assert.match(section, /Hannes is an older miner/);
  assert.match(section, /train for a rematch/);
  assert.match(section, /nice round salary/);
});

test("Orry lore is branded by name and omitted for other bots", () => {
  withBrand("Orry the ore Maulwürf", "rivet", () => {
    const text = identity.corpusSection({ id: "loadout", name: "Loadout" });
    assert.equal(identity.sourceName(), "About Orry");
    assert.match(text, /Hannes/);
    assert.match(text, /Olympic swimming champion/);
    assert.match(text, /train for a rematch/);
    assert.match(text, /huge private stash/);
  });
  withBrand("Helper", "helper", () => {
    const text = identity.corpusSection({ id: "demo", name: "Demo" });
    assert.equal(identity.sourceName(), "About Helper");
    assert.doesNotMatch(text, /Hannes|Goose Lee|Ruhr area/);
  });
});

test("Loadout identity includes Orry's greed, pride, generosity, and Goose rivalry", () => {
  withBrand("Orry the ore Maulwürf", "rivet", () => {
    const text = identity.corpusSection({ id: "loadout", name: "Loadout" });
    assert.match(text, /I love looking at my money\. It's mine, and I'll get more/i);
    assert.doesNotMatch(text, /pride in being wealthy helps cover the hurt/i);
    assert.match(text, /Q: Were you bullied/i);
    assert.match(text, /I don't need pity; look at the stash now/i);
    assert.match(text, /compare myself.*motivation to improve/i);
    assert.match(text, /grumble about the cost.*still help/i);
    assert.match(text, /Pond University/i);
    assert.match(text, /popular.*good-looking.*good grades/i);
    assert.match(text, /risk and adventure, not the paycheck/i);
    assert.match(text, /Goose.*martial arts/i);
    assert.match(text, /nowhere near a gold or black belt.*stopped arguing/i);
    assert.match(text, /Q: What happened in the mine accident/i);
    assert.doesNotMatch(
      text,
      /Goose turned her down|Goose thinks our rivalry is playful|Goose was shocked to see|Goose respects that I put my grief aside/i,
    );
    assert.match(text, /That's all I'm saying/i);
    assert.match(text, /Q: What is the next adventure with Goose/i);
    assert.match(text, /Goose wants the risk and adventure; I want the treasure/i);
  });
});

test("Loadout identity names Orry as the bot Netic built", () => {
  withBrand("Orry the ore Maulwürf", "rivet", () => {
    const text = identity.corpusSection({ id: "loadout", name: "Loadout" });
    assert.match(text, /Orry the ore Maulwürf was built by Netic/);
    assert.match(text, /Netic also built Rivet, Loadout's Slack bot/);
  });
});

test("identity override replaces generated text", () => {
  const saved = process.env.RIVET_IDENTITY_OVERRIDE;
  process.env.RIVET_IDENTITY_OVERRIDE = "Q: Who are you?\nA: A test bot.";
  try {
    assert.equal(identity.corpusSection({ id: "acme", name: "Acme" }), process.env.RIVET_IDENTITY_OVERRIDE);
  } finally {
    if (saved === undefined) delete process.env.RIVET_IDENTITY_OVERRIDE;
    else process.env.RIVET_IDENTITY_OVERRIDE = saved;
  }
});

test("program identity uses its configured name, support name, and channel", () => {
  const text = identity.corpusSection({
    id: "demo",
    name: "Demo",
    supportName: "Demo Support",
    helpChannel: "C_HELP",
    scope: "program",
  });
  assert.match(text, /I'm Demo Support/);
  assert.match(text, /<#C_HELP>/);
  assert.match(text, /only do Demo/);
});

test("unscoped program identity can name other configured programs", () => {
  const text = identity.corpusSection({ id: "acme", name: "Acme", helpChannel: "C_HELP" });
  assert.match(text, /Acme/);
  assert.match(text, /Other programs I know about/);
});

test("branding changes command and support identity without changing the corpus contract", () => {
  withBrand("Helper", "helper", () => {
    const text = identity.corpusSection({ id: "beta", name: "Beta", helpChannel: "C_BETA" });
    assert.match(text, /I'm Helper/);
    assert.match(text, /\/helper-sources/);
    assert.doesNotMatch(text, /\$\{botName\}/);
  });
});

test("identity text has no dash punctuation for model output", () => {
  const text = identity.corpusSection({ id: "demo", name: "Demo", helpChannel: "C_HELP" });
  assert.doesNotMatch(text, /[—–]/);
});

export {};
