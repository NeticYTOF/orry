/* Seeds data/site.db with invented accounts, invites and access events so every screen has content.
   Run by `npm run dev` when the database is new; by hand: `npm run seed` (refuses if accounts exist)
   or `npm run seed -- --force` (deletes the database first). Names never go in the database, only Slack IDs. */
import fs from "node:fs";
import { dbPath, getDb, now, setDbForTests } from "../lib/db";
import { sha256, randomToken } from "../lib/auth/crypto";
import { byHandle } from "../lib/data/fixtures/people";

const H = 3_600_000, D = 86_400_000;
const id = (handle: string): string => {
  const p = byHandle(handle);
  if (!p) throw new Error("not in the fixtures: " + handle);
  return p.id;
};
const sub = (slackId: string) => "dev-hca-" + slackId.toLowerCase();

export type SeedResult = { pending: Array<{ handle: string; link: string }> };

export function seedDev(base = process.env.ORRY_SITE_URL || "http://localhost:3200"): SeedResult {
  const db = getDb();
  const n = Number((db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n);
  if (n > 0) throw new Error("The database already has accounts. Use --force to start over.");
  const t = now();
  const pat = id("pat-placeholder");

  db.exec("BEGIN IMMEDIATE");
  try {
    const acct = db.prepare("INSERT INTO accounts (slack_id, hca_sub, role, status, created_at, created_by, last_sign_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const people: Array<[string, "helper" | "organizer", "on" | "off", number, number]> = [
      ["pat-placeholder", "organizer", "on", 40 * D, 2 * 60_000 + 30 * 60_000],
      ["pixel-otter", "helper", "on", 30 * D, 50 * 60_000],
      ["copper-wren", "helper", "on", 30 * D, 3 * H],
      ["fuse-badger", "helper", "on", 28 * D, 1 * D + 2 * H],
      ["drill-heron", "helper", "on", 25 * D, 3 * D],
      ["lamp-ferret", "helper", "on", 20 * D, 5 * D],
      ["soldermoth", "helper", "off", 35 * D, 8 * D],
      ["tin-lark", "helper", "on", 5 * D, 5 * D - H]
    ];
    for (const [h, role, status, made, last] of people) {
      acct.run(id(h), sub(id(h)), role, status, t - made, h === "pat-placeholder" ? "bootstrap" : pat, t - last);
    }

    const inv = db.prepare("INSERT INTO invites (token_hash, slack_id, role, created_by, created_at, expires_at, state, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const pending: SeedResult["pending"] = [];
    const add = (handle: string, created: number, days: number, state: "pending" | "used" | "cancelled", usedAgo: number | null) => {
      const token = randomToken(32);
      inv.run(sha256(token), id(handle), "helper", pat, t - created, t - created + days * D, state, usedAgo === null ? null : t - usedAgo);
      if (state === "pending" && t - created + days * D > t) pending.push({ handle, link: `${base}/invite/${token}` });
    };
    add("sand-finch", 1 * D, 7, "pending", null);         /* open, in 6 days */
    add("quartz-hare", 5 * D, 7, "pending", null);        /* open, in 2 days */
    add("old-badger", 10 * D, 7, "pending", null);        /* expired 3 days ago */
    add("coal-newt", 9 * D, 7, "cancelled", null);        /* cancelled */
    add("tin-lark", 6 * D, 7, "used", 5 * D);             /* used 5 days ago */

    const ev = db.prepare("INSERT INTO access_events (at, actor_slack_id, kind, subject_slack_id, reason) VALUES (?, ?, ?, ?, ?)");
    const E: Array<[number, string | null, string, string | null, string | null]> = [
      [t - 40 * D, null, "bootstrap", pat, null],
      [t - 10 * D, pat, "invite_created", id("old-badger"), "helper"],
      [t - 9 * D, pat, "invite_created", id("coal-newt"), "helper"],
      [t - 8 * D, pat, "invite_cancelled", id("coal-newt"), null],
      [t - 8 * D + H, pat, "account_off", id("soldermoth"), null],
      [t - 6 * D, pat, "invite_created", id("tin-lark"), "helper"],
      [t - 5 * D, id("tin-lark"), "invite_used", id("tin-lark"), "helper"],
      [t - 5 * D, pat, "invite_created", id("quartz-hare"), "helper"],
      [t - 1 * D, pat, "invite_created", id("sand-finch"), "helper"],
      [t - 1 * D - 2 * H, id("fuse-badger"), "sign_in", id("fuse-badger"), null],
      [t - 3 * H, id("copper-wren"), "sign_in", id("copper-wren"), null],
      [t - 80 * 60_000, "U07K2QX4D1", "sign_in_refused", "U07K2QX4D1", "no_account"],
      [t - 50 * 60_000, id("pixel-otter"), "sign_in", id("pixel-otter"), null],
      [t - 32 * 60_000, pat, "sign_in", pat, null]
    ];
    for (const e of E) ev.run(...e);
    db.exec("COMMIT");
    return { pending };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function banner(base: string, seeded: SeedResult | null): string {
  const lines = [
    "",
    "  LOADOUT ORRY help desk (local, invented data)",
    "",
    `  Open        ${base}/sign-in`,
    "  Sign in     use the dev panel under the button: Pat Placeholder is an organizer,",
    "              Juno, Leila, Ravi, Mia and Noah are helpers, Zara is turned off.",
    `  Admin       ${base}/team  and  ${base}/config  (as Pat)`
  ];
  if (seeded) {
    lines.push("", "  Open invites (each link works once; sign in as the same person in the dev panel):");
    for (const p of seeded.pending) lines.push(`    @${p.handle.padEnd(12)} ${p.link}`);
    lines.push("  @sand-finch is on Orry's helper list in the fixtures, so that invite ends inside the app.", "  @quartz-hare is not, so it ends on the 'not on the helper list' page (the second lock).");
  } else {
    lines.push("", "  Invite links were printed when the database was made. Make a new one on Team and invites,", "  or start over with: npm run seed -- --force");
  }
  lines.push("");
  return lines.join("\n");
}

/* run directly */
if (/seed-dev.ts$/.test(process.argv[1] ?? "")) {
  const force = process.argv.includes("--force");
  const file = dbPath();
  if (force) {
    setDbForTests(null);
    for (const f of [file, file + "-wal", file + "-shm"]) if (fs.existsSync(f)) fs.rmSync(f);
  }
  try {
    const r = seedDev();
    console.log(banner(process.env.ORRY_SITE_URL || "http://localhost:3200", r));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
