/* Invented people, shared by the fixtures, the dev sign-in and the dev seed. None of these are real. */
import type { Person } from "../types";

export const PEOPLE: Person[] = [
  { id: "U0PAT0001", handle: "pat-placeholder", name: "Pat Placeholder" },
  { id: "U0JUNO001", handle: "pixel-otter", name: "Juno Baker" },
  { id: "U0LEILA01", handle: "copper-wren", name: "Leila Haddad" },
  { id: "U0RAVI001", handle: "drill-heron", name: "Ravi Patel" },
  { id: "U0MIA0001", handle: "fuse-badger", name: "Mia Kowalski" },
  { id: "U0NOAH001", handle: "lamp-ferret", name: "Noah Berg" },
  { id: "U0ZARA001", handle: "soldermoth", name: "Zara Ahmed" },
  /* invited or known in the workspace, but not on the helper list or not yet signed in */
  { id: "U0SAM0001", handle: "sand-finch", name: "Sam Rivera" },
  { id: "U0QUIN001", handle: "quartz-hare", name: "Quinn Ortega" },
  { id: "U0OLI0001", handle: "old-badger", name: "Oli Brandt" },
  { id: "U0TESS001", handle: "tin-lark", name: "Tess Lindqvist" },
  { id: "U0CAL0001", handle: "coal-newt", name: "Cal Nguyen" },
  { id: "U0MAX0001", handle: "mint-vole", name: "Max Voss" },
  { id: "U0FERN001", handle: "fern-shrike", name: "Fern Okafor" },
  { id: "U0OTHER01", handle: "other-person", name: "Alex Other" }
];

/** Orry's own helper list in the fixtures (program "loadout"). Organizers are the bot's admin list. */
export const ORGANIZER_IDS = ["U0PAT0001"];
export const HELPER_IDS = ["U0JUNO001", "U0LEILA01", "U0RAVI001", "U0MIA0001", "U0NOAH001", "U0ZARA001", "U0TESS001", "U0SAM0001"];

export const byId = (id: string): Person | undefined => PEOPLE.find(p => p.id === id);
export const byHandle = (h: string): Person | undefined => PEOPLE.find(p => p.handle === h.replace(/^@/, "").toLowerCase());
