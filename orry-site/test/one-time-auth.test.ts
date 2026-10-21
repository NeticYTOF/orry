import { randomBytes, scryptSync } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getDb, openDb, setDbForTests } from "../lib/db";
import { oneTimePasswordEnabled } from "../lib/auth/config";
import {
  canTryOneTimePassword,
  recordOneTimePasswordFailure,
  redeemOneTimePassword,
  verifyOneTimePassword,
} from "../lib/auth/one-time";
import { accountById, sessionByToken } from "../lib/auth/store";

const keys = ["ORRY_SITE_OTP_SALT", "ORRY_SITE_OTP_HASH", "ORRY_SITE_OTP_SLACK_ID", "ORRY_COOKIE_SECRET"] as const;
const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  const salt = randomBytes(16);
  process.env.ORRY_SITE_OTP_SALT = salt.toString("base64url");
  process.env.ORRY_SITE_OTP_HASH = scryptSync("test-one-time-code", salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("hex");
  process.env.ORRY_SITE_OTP_SLACK_ID = "U0AULNJD6L8";
  process.env.ORRY_COOKIE_SECRET = "test-cookie-signing-secret-that-is-long-enough";
});

afterEach(() => {
  setDbForTests(null);
  for (const k of keys) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

it("accepts only a configured password and burns it atomically after one login", () => {
  expect(oneTimePasswordEnabled()).toBe(true);
  expect(verifyOneTimePassword("wrong-code")).toBe(false);
  expect(verifyOneTimePassword("test-one-time-code")).toBe(true);

  const first = redeemOneTimePassword("test-one-time-code");
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const session = sessionByToken(first.token);
  expect(session).not.toBeNull();
  expect(accountById(session!.accountId)?.role).toBe("helper");
  expect(redeemOneTimePassword("test-one-time-code")).toEqual({ ok: false, reason: "used" });
  expect(Number((getDb().prepare("SELECT COUNT(*) AS n FROM used_one_time_passwords").get() as { n: number }).n)).toBe(
    1,
  );
});

it("locks all attempts after five failed tries", () => {
  for (let i = 0; i < 5; i++) recordOneTimePasswordFailure();
  expect(canTryOneTimePassword()).toBe(false);
});
