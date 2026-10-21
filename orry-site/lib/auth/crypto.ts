/* Random tokens, hashes and signed short-lived cookies. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes as base64url (256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/* The key that signs the short cookies (oauth state, invite, flash). ORRY_COOKIE_SECRET when set;
   otherwise a random key per server process, so a restart only ends sign-ins that are half done. */
const G = globalThis as unknown as { __orryCookieKey?: Buffer };
function key(): Buffer {
  const env = process.env.ORRY_COOKIE_SECRET;
  if (env && env.length >= 32) return Buffer.from(env, "utf8");
  if (!G.__orryCookieKey) G.__orryCookieKey = randomBytes(32);
  return G.__orryCookieKey;
}

/** value = base64url(json) + "." + base64url(hmac). Carries its own expiry. */
export function sign(payload: object, ttlMs: number, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: nowMs + ttlMs }), "utf8").toString("base64url");
  const mac = createHmac("sha256", key()).update(body).digest("base64url");
  return body + "." + mac;
}

export function unsign<T extends object>(value: string | undefined | null, nowMs = Date.now()): T | null {
  if (!value || typeof value !== "string") return null;
  const i = value.lastIndexOf(".");
  if (i < 1) return null;
  const body = value.slice(0, i), mac = value.slice(i + 1);
  const want = createHmac("sha256", key()).update(body).digest();
  let got: Buffer;
  try { got = Buffer.from(mac, "base64url"); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof obj.exp !== "number" || obj.exp < nowMs) return null;
    return obj;
  } catch {
    return null;
  }
}
