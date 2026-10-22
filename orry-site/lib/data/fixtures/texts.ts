/* Invented question texts and participant handles for the fixtures. Nothing here is real. Short on purpose.
   Each category's texts contain a keyword the bot's default classifier would match (lib/ticketCategory.ts:13-38),
   and "other" texts contain none of them. */

export const CATEGORIES = ["review", "advice_how_to", "other", "site_bug", "fulfillment_shipping", "account_access"] as const;
export type Category = (typeof CATEGORIES)[number];

export const TEXTS: Record<Category, string[]> = {
  review: [
    "How do I submit my demo link for review?",
    "Can I resubmit after the deadline?",
    "Review says I need a README. Where does it go?",
    "When does the next review window open?",
    "My reviewer left feedback but I can't find it.",
    "Is there a rubric for the hardware review?",
    "My submission was rejected for a missing photo. Can I add it?",
    "Does the reviewer need my source files or just the build log?",
    "How long does approval usually take after I submit?",
    "Can two people submit the same project for review?"
  ],
  advice_how_to: [
    "Which board does the starter kit use? How do I set it up?",
    "How do I change my project's title?",
    "Do hardware parts count toward the budget? How do I log them?",
    "How do I add a second teammate to my project?",
    "How can I export my wiring diagram as an image?",
    "How to install the firmware on the kit board?",
    "How do I track hours for work I did offline?",
    "Any advice on soldering the header pins?",
    "How do I configure the serial monitor speed?",
    "Is there a guide for the Compute track kit?"
  ],
  other: [
    "Is there a limit on how many projects I can make?",
    "Can I use a prebuilt case for my build?",
    "Is the Discord server the same as this Slack?",
    "What time zone are the deadlines in?",
    "Can I work on two tracks at once?",
    "Who runs the Thursday call?",
    "Are stickers part of the kit?",
    "Can I keep my build after the program ends?"
  ],
  site_bug: [
    "The build page shows an error after I save.",
    "The page shows a blank screen after I sign in. Bug?",
    "My hours chart is broken on mobile.",
    "Upload button not working in Firefox.",
    "The project gallery is not loading for me.",
    "Getting a crash when I open the parts list."
  ],
  fulfillment_shipping: [
    "My shipping address was wrong on the order.",
    "Where do I find my tracking number?",
    "Has my package shipped yet?",
    "Can I change the delivery address for my kit?",
    "When will rewards for approved builds go out?"
  ],
  account_access: [
    "I can't log in with my Slack account.",
    "My teammate can't access the repo I linked.",
    "Can I change the email on my account?",
    "I lost access after changing my password."
  ]
};

const ADJ = ["tiny", "moss", "night", "bright", "iron", "lumen", "grit", "pebble", "opal", "rust", "cinder", "fern", "drift", "brass", "loam", "mica",
  "sable", "amber", "frost", "dune", "cobalt", "ember", "flint", "glade", "hazel", "ivory", "jade", "kelp", "lilac", "maple"];
const NOUN = ["geode", "kiln", "tern", "moth", "shale", "sprout", "vole", "heron2", "lynx", "mite", "pika", "ibis", "quokka", "wisp", "yak", "gnat", "crane",
  "shrew", "finch2", "otter2", "gecko", "marten", "plover", "skink", "tapir", "urchin", "weevil", "zebu"];

/** Invented participants: Slack-shaped IDs that start with U0R (no real workspace uses these), handles like tiny-geode. */
export function participants(n: number): Array<{ id: string; handle: string }> {
  const out: Array<{ id: string; handle: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < n && i < ADJ.length * NOUN.length; i++) {
    const a = ADJ[(i * 7) % ADJ.length], b = NOUN[(i * 11 + Math.floor(i / ADJ.length)) % NOUN.length].replace(/\d$/, "");
    const handle = `${a}-${b}`;
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push({ id: `U0R${String(out.length + 1).padStart(6, "0")}`, handle });
  }
  return out;
}
