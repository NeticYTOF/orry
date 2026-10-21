/* Test doubles for the auth tests: a stub data source (Orry's roster and Slack names) and a fresh in-memory database.
   Test files mock lib/data with this stub, so they do not depend on the DATA agent's sources. */
import { roster, stub } from "./auth-stub";
export { roster, stub };
import { openDb, setDbForTests, setNowForTests, getDb } from "../lib/db";
import { clearNameCacheForTests } from "../lib/auth/roster";
import { resetRateLimitsForTests } from "../lib/security";
import { insertAccount } from "../lib/auth/store";

export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

export function fresh(): void {
  setDbForTests(openDb(":memory:"));
  setNowForTests(T0);
  clearNameCacheForTests();
  resetRateLimitsForTests();
  roster.down = false;
  roster.calls = 0;
  roster.admin = new Set(["U0PAT0001"]);
  roster.helper = new Set(["U0JUNO001", "U0LEILA01", "U0RAVI001", "U0MIA0001", "U0NOAH001", "U0ZARA001", "U0TESS001", "U0SAM0001"]);
}

export const sub = (slackId: string) => "hca-" + slackId.toLowerCase();
export const identity = (slackId: string | null, s?: string) => ({ sub: s ?? sub(slackId ?? "none"), slackId });

/** An account that has signed in before (hca_sub set). */
export function account(slackId: string, role: "helper" | "organizer" = "helper", status: "on" | "off" = "on"): number {
  return insertAccount({ slackId, hcaSub: sub(slackId), role, status, createdBy: "U0PAT0001", lastSignInAt: T0 - 86_400_000 });
}

export const count = (sql: string, ...a: Array<string | number>) => Number((getDb().prepare(sql).get(...a) as { n: number }).n);
export const advance = (ms: number) => { const g = globalThis as unknown as { __orryNow: number }; setNowForTests(g.__orryNow + ms); };
