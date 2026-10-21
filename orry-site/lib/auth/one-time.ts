/* Single-use site password: only a scrypt verifier is configured, and only its digest is retained after redemption. */
import { createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb, now, tx } from "../db";
import { accountBySlack, createSession, deleteSessionByToken, insertAccount } from "./store";
import { logEvent } from "./events";

const HOUR = 60 * 60_000;
const MAX_FAILURES = 5;
const KEY_BYTES = 32;

function config() {
  const saltText = process.env.ORRY_SITE_OTP_SALT || "";
  const hashText = process.env.ORRY_SITE_OTP_HASH || "";
  const slackId = process.env.ORRY_SITE_OTP_SLACK_ID || "";
  if (
    !/^[A-Za-z0-9_-]{20,32}$/.test(saltText) ||
    !/^[a-f0-9]{64}$/i.test(hashText) ||
    !/^[UW][A-Z0-9]{8,14}$/.test(slackId)
  )
    return null;
  const salt = Buffer.from(saltText, "base64url");
  const hash = Buffer.from(hashText, "hex");
  return salt.length >= 16 && hash.length === KEY_BYTES ? { salt, hash, slackId } : null;
}

export function canTryOneTimePassword(): boolean {
  const row = getDb()
    .prepare("SELECT window_start, failures, locked_until FROM one_time_attempts WHERE id = 1")
    .get() as { window_start: number; failures: number; locked_until: number } | undefined;
  const t = now();
  return !row || (row.locked_until <= t && (t - row.window_start >= HOUR || row.failures < MAX_FAILURES));
}

export function recordOneTimePasswordFailure(): void {
  const t = now();
  tx(() => {
    const row = getDb().prepare("SELECT window_start, failures FROM one_time_attempts WHERE id = 1").get() as
      { window_start: number; failures: number } | undefined;
    const fresh = !row || t - row.window_start >= HOUR;
    const start = fresh ? t : row.window_start;
    const failures = fresh ? 1 : row.failures + 1;
    const lockedUntil = failures >= MAX_FAILURES ? t + HOUR : 0;
    getDb()
      .prepare(
        `INSERT INTO one_time_attempts (id, window_start, failures, locked_until)
      VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      window_start = excluded.window_start, failures = excluded.failures, locked_until = excluded.locked_until`,
      )
      .run(start, failures, lockedUntil);
  });
}

export function verifyOneTimePassword(candidate: string): boolean {
  const c = config();
  if (!c || candidate.length > 256) return false;
  const derived = scryptSync(candidate, c.salt, KEY_BYTES, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(derived, c.hash);
}

export type Redemption =
  { ok: true; token: string } | { ok: false; reason: "unconfigured" | "invalid" | "used" | "account_off" };

export function redeemOneTimePassword(candidate: string, oldToken?: string | null): Redemption {
  const c = config();
  if (!c || candidate.length > 256) return { ok: false, reason: "unconfigured" };
  const derived = scryptSync(candidate, c.salt, KEY_BYTES, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  if (!timingSafeEqual(derived, c.hash)) return { ok: false, reason: "invalid" };
  const digest = createHash("sha256").update(derived).digest("hex");

  return tx(() => {
    if (getDb().prepare("SELECT 1 FROM used_one_time_passwords WHERE digest = ?").get(digest))
      return { ok: false, reason: "used" };
    const account = accountBySlack(c.slackId);
    if (account?.status === "off") return { ok: false, reason: "account_off" };
    const t = now();
    const accountId = account
      ? (getDb().prepare("UPDATE accounts SET role = 'helper' WHERE id = ?").run(account.id), account.id)
      : insertAccount({
          slackId: c.slackId,
          hcaSub: `otp:${digest}`,
          role: "helper",
          createdBy: null,
          createdAt: t,
          lastSignInAt: t,
        });
    if (account) getDb().prepare("UPDATE accounts SET last_sign_in_at = ? WHERE id = ?").run(t, accountId);
    getDb().prepare("INSERT INTO used_one_time_passwords (digest, consumed_at) VALUES (?, ?)").run(digest, t);
    getDb().prepare("DELETE FROM one_time_attempts WHERE id = 1").run();
    if (oldToken) deleteSessionByToken(oldToken);
    const token = createSession(accountId);
    logEvent("sign_in", c.slackId, { subject: c.slackId, reason: "one_time_password" });
    return { ok: true, token };
  });
}
