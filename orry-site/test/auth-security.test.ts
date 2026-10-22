/* Return paths (PLAN 7.2 step 7), the Origin check (7.4), the signed cookies and the headers. */
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, originAllowed, safeReturnPath, securityHeaders, takeToken } from "../lib/security";
import { sign, unsign } from "../lib/auth/crypto";
import { cookieNames } from "../lib/auth/config";

const hdr = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

describe("return path after sign-in", () => {
  it.each([
    ["//evil.example", "/board"],
    ["//evil.example/board", "/board"],
    ["/\\evil.example", "/board"],
    ["/\\/evil.example", "/board"],
    ["https://evil.example/board", "/board"],
    ["http://localhost:9995/board", "/board"],
    ["javascript:alert(1)", "/board"],
    ["board", "/board"],
    ["/%2F%2Fevil.example", "/board"],
    ["/%5Cevil.example", "/board"],
    ["/board\n", "/board"],
    ["/sign-in", "/board"],           /* not a signed-in page */
    ["/api/team/invites", "/board"],  /* not a page */
    ["/nowhere", "/board"],           /* not on the route list */
    ["", "/board"],
    [undefined, "/board"]
  ])("%j becomes %j", (input, want) => {
    expect(safeReturnPath(input)).toBe(want);
  });

  it.each([
    ["/board", "/board"],
    ["/board?view=mine", "/board?view=mine"],
    ["/tickets/1042", "/tickets/1042"],
    ["/stats?week=2026-W42", "/stats?week=2026-W42"],
    ["/team", "/team"]
  ])("%j is kept", (input, want) => {
    expect(safeReturnPath(input)).toBe(want);
  });
});

describe("Origin check on non-GET requests", () => {
  const site = "http://localhost:9995";
  it("accepts the exact site origin", () => {
    expect(originAllowed(hdr({ origin: site }), site)).toBe(true);
  });
  it.each([
    "https://localhost:9995", "http://localhost:9996", "http://127.0.0.1:9995", "http://evil.example",
    "http://localhost:9995.evil.example", "https://poorup.jeremy-d.hackclub.app"
  ])("refuses %s", o => {
    expect(originAllowed(hdr({ origin: o }), site)).toBe(false);
  });
  it("refuses a missing or null Origin unless the browser says same-origin", () => {
    expect(originAllowed(hdr({}), site)).toBe(false);
    expect(originAllowed(hdr({ origin: "null" }), site)).toBe(false);
    expect(originAllowed(hdr({ origin: "null", "sec-fetch-site": "same-site" }), site)).toBe(false);
    expect(originAllowed(hdr({ "sec-fetch-site": "cross-site" }), site)).toBe(false);
    expect(originAllowed(hdr({ origin: "null", "sec-fetch-site": "same-origin" }), site)).toBe(true);
    expect(originAllowed(hdr({ "sec-fetch-site": "same-origin" }), site)).toBe(true);
  });
  it("a wrong Origin wins over a same-origin hint", () => {
    expect(originAllowed(hdr({ origin: "http://evil.example", "sec-fetch-site": "same-origin" }), site)).toBe(false);
  });
});

describe("signed short cookies", () => {
  it("round-trip, and refuse tampering and expiry", () => {
    const v = sign({ i: 7 }, 60_000, 1000);
    expect(unsign<{ i: number }>(v, 2000)?.i).toBe(7);
    expect(unsign(v, 1000 + 60_001)).toBeNull();
    const [body, mac] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ i: 8, exp: 9e15 })).toString("base64url") + "." + mac;
    expect(unsign(forged, 2000)).toBeNull();
    expect(unsign(body + ".", 2000)).toBeNull();
    expect(unsign("garbage", 2000)).toBeNull();
  });
});

describe("cookies and headers", () => {
  it("uses plain names on http://localhost (no __Host- without Secure)", () => {
    expect(cookieNames.session).toBe("orry_session");
  });
  it("uses __Host- names on https", () => {
    const old = process.env.ORRY_SITE_URL;
    process.env.ORRY_SITE_URL = "https://orry.example";
    try { expect(cookieNames.session).toBe("__Host-orry_session"); expect(cookieNames.oauth).toBe("__Host-orry_oauth"); }
    finally { process.env.ORRY_SITE_URL = old; }
  });
  it("sends the 7.4 headers; HSTS only on https; unsafe-eval only in dev", () => {
    const p = securityHeaders("abc", { dev: false, https: true });
    expect(p["Content-Security-Policy"]).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(p["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(p["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(p["Strict-Transport-Security"]).toBe("max-age=31536000");
    expect(p["X-Content-Type-Options"]).toBe("nosniff");
    expect(p["Referrer-Policy"]).toBe("no-referrer");
    expect(p["X-Robots-Tag"]).toContain("noindex");
    expect(p["Permissions-Policy"]).toContain("camera=()");
    expect(p["Cache-Control"]).toBe("no-store, private");
    expect(securityHeaders("abc", { dev: false, https: false })["Strict-Transport-Security"]).toBeUndefined();
    expect(contentSecurityPolicy("abc", true)).toContain("'unsafe-eval'");
  });
  it("rate limit: a bucket runs dry and refills", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(takeToken("t1", 1, 3, t)).toBe(true);
    expect(takeToken("t1", 1, 3, t)).toBe(false);
    expect(takeToken("t1", 1, 3, t + 1000)).toBe(true);
  });
});
