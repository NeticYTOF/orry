process.env.RIVET_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const brand = require("./brand");

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("with nothing set, the bot uses Orry's display name and commands", () => {
  withEnv({ RIVET_BOT_NAME: undefined, RIVET_BOT_SLUG: undefined }, () => {
    assert.equal(brand.name(), "Orry the ore Maulwürf");
    assert.equal(brand.slug(), "orry");
    assert.equal(brand.cmd(), "/orry");
    assert.equal(brand.cmd("teach"), "/orry-teach");
  });
});

test("a bot's name and slug drive its commands", () => {
  withEnv({ RIVET_BOT_NAME: "Sol", RIVET_BOT_SLUG: "sol" }, () => {
    assert.equal(brand.name(), "Sol");
    assert.equal(brand.cmd(), "/sol");
    assert.equal(brand.cmd("gaps"), "/sol-gaps");
  });
});

test("the slug is derived from the name when only the name is set", () => {
  withEnv({ RIVET_BOT_NAME: "Athena", RIVET_BOT_SLUG: undefined }, () => {
    assert.equal(brand.slug(), "athena");
    assert.equal(brand.cmd("teach"), "/athena-teach");
  });
});

test("the renamed default uses the orry slash command prefix", () => {
  withEnv({ RIVET_BOT_NAME: "Orry the ore Maulwürf", RIVET_BOT_SLUG: undefined }, () => {
    assert.equal(brand.slug(), "orry");
    assert.equal(brand.cmd(), "/orry");
  });
});

test("a display name with spaces or caps is slugified before becoming a command", () => {
  withEnv({ RIVET_BOT_NAME: "Sol Helper Bot", RIVET_BOT_SLUG: undefined }, () => {
    assert.equal(brand.slug(), "sol-helper-bot");
    assert.equal(brand.cmd(), "/sol-helper-bot");
  });
});

test("punctuation is stripped rather than passed into a command name", () => {
  withEnv({ RIVET_BOT_SLUG: "Solvable! YSWS (2026)" }, () => {
    assert.equal(brand.slug(), "solvable-ysws-2026");
  });
});

test("a slug that slugifies to nothing falls back rather than producing '/'", () => {
  withEnv({ RIVET_BOT_SLUG: "!!!" }, () => {
    assert.equal(brand.slug(), "orry");
    assert.equal(brand.cmd(), "/orry");
  });
});

test("an empty or whitespace value is treated as unset", () => {
  withEnv({ RIVET_BOT_NAME: "   ", RIVET_BOT_SLUG: "" }, () => {
    assert.equal(brand.name(), "Orry the ore Maulwürf");
    assert.equal(brand.slug(), "orry");
  });
});

test("payload ids are underscored", () => {
  withEnv({ RIVET_BOT_SLUG: "sol-helper" }, () => {
    assert.equal(brand.id("teach_thread"), "sol_helper_teach_thread");
  });
});

test("brand values are read per call, not captured at require time", () => {
  withEnv({ RIVET_BOT_SLUG: "first" }, () => {
    assert.equal(brand.cmd(), "/first");
  });
  withEnv({ RIVET_BOT_SLUG: "second" }, () => {
    assert.equal(brand.cmd(), "/second");
  });
});

test("defaults are the Orry identity", () => {
  withEnv({ RIVET_BOT_NAME: undefined, RIVET_BOT_SLUG: undefined }, () => {
    assert.equal(brand.name(), brand.DEFAULT_NAME);
    assert.equal(brand.slug(), brand.DEFAULT_SLUG);
  });
});

test("rebranded commands carry no rivet residue", () => {
  withEnv({ RIVET_BOT_NAME: "Sol", RIVET_BOT_SLUG: "sol" }, () => {
    assert.doesNotMatch(brand.cmd(), /rivet/);
    assert.doesNotMatch(brand.cmd("teach"), /rivet/);
    assert.doesNotMatch(brand.id("teach_thread"), /rivet/);
  });
});

test("cmd with empty suffix is the bare ask command", () => {
  withEnv({ RIVET_BOT_SLUG: "sol" }, () => {
    assert.equal(brand.cmd(""), "/sol");
    assert.match(brand.cmd("report"), /^\/sol-report$/);
  });
});
export {};
