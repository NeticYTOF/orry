// The invented program and people for scripts/dev-bridge.ts. Dev only: the
// bot never imports this file. No imports, so the dev bridge can read the
// admin list before anything loads lib/config.ts. The people and their Slack
// ids mirror the status site's fixtures (orry-site/lib/data/fixtures/people.ts).

const PROGRAM_ID = "loadout";
const WORKSPACE_ID = "T0DEVWS01";
const CHANNELS = { help: "C0DEVHELP1", main: "C0DEVMAIN1", organizer: "C0DEVORG01" };

const PEOPLE = [
  { id: "U0PAT0001", handle: "pat-placeholder", name: "Pat Placeholder" },
  { id: "U0JUNO001", handle: "pixel-otter", name: "Juno Baker" },
  { id: "U0LEILA01", handle: "copper-wren", name: "Leila Haddad" },
  { id: "U0RAVI001", handle: "drill-heron", name: "Ravi Patel" },
  { id: "U0MIA0001", handle: "fuse-badger", name: "Mia Kowalski" },
  { id: "U0NOAH001", handle: "lamp-ferret", name: "Noah Berg" },
  { id: "U0ZARA001", handle: "soldermoth", name: "Zara Ahmed" },
  { id: "U0SAM0001", handle: "sand-finch", name: "Sam Rivera" },
  { id: "U0QUIN001", handle: "quartz-hare", name: "Quinn Ortega" },
  { id: "U0OLI0001", handle: "old-badger", name: "Oli Brandt" },
  { id: "U0TESS001", handle: "tin-lark", name: "Tess Lindqvist" },
  { id: "U0CAL0001", handle: "coal-newt", name: "Cal Nguyen" },
  { id: "U0MAX0001", handle: "mint-vole", name: "Max Voss" },
  { id: "U0FERN001", handle: "fern-shrike", name: "Fern Okafor" },
  { id: "U0OTHER01", handle: "other-person", name: "Alex Other" },
];
const ORGANIZER_IDS = ["U0PAT0001"];
const HELPER_IDS = [
  "U0JUNO001",
  "U0LEILA01",
  "U0RAVI001",
  "U0MIA0001",
  "U0NOAH001",
  "U0ZARA001",
  "U0TESS001",
  "U0SAM0001",
];
// How busy each helper is, so the leaderboard is not flat.
const HELPER_WEIGHTS = [6, 5, 3, 3, 2, 2, 1, 1];

// Participants (minors in real life): invented ids and placeholder names only.
const PARTICIPANTS = Array.from({ length: 40 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return { id: `U0KID00${n}`, handle: `maker-${n}`, name: `Maker ${n}` };
});
const BOT_MEMBER = { id: "U0BOTDEV1", handle: "some-other-bot", name: "Some Other Bot", isBot: true };

export = {
  PROGRAM_ID,
  WORKSPACE_ID,
  CHANNELS,
  PEOPLE,
  ORGANIZER_IDS,
  HELPER_IDS,
  HELPER_WEIGHTS,
  PARTICIPANTS,
  BOT_MEMBER,
};
