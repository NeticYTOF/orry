import { afterEach, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/auth/start/route";
import { GET } from "../app/(auth)/auth/callback/route";

const names = [
  "ORRY_SITE_URL",
  "ORRY_COOKIE_SECRET",
  "ORRY_HCA_CLIENT_ID",
  "ORRY_HCA_CLIENT_SECRET",
  "ORRY_SITE_OTP_SALT",
  "ORRY_SITE_OTP_HASH",
  "ORRY_SITE_OTP_SLACK_ID",
] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

function configure() {
  process.env.ORRY_SITE_URL = "https://orry.example";
  process.env.ORRY_COOKIE_SECRET = "test-cookie-signing-secret-that-is-long-enough";
  process.env.ORRY_HCA_CLIENT_ID = "hca-client";
  process.env.ORRY_HCA_CLIENT_SECRET = "hca-secret";
  process.env.ORRY_SITE_OTP_SALT = "A".repeat(22);
  process.env.ORRY_SITE_OTP_HASH = "f".repeat(64);
  process.env.ORRY_SITE_OTP_SLACK_ID = "U0AULNJD6L8";
};

afterEach(() => {
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

it("keeps Hack Club OAuth available when the one-time password is configured", async () => {
  configure();
  const req = new NextRequest("https://orry.example/api/auth/start", {
    method: "POST",
    headers: { origin: "https://orry.example", "content-type": "application/x-www-form-urlencoded" },
    body: "provider=hca",
  });
  const res = await POST(req);
  const location = new URL(res.headers.get("location")!);
  expect(res.status).toBe(303);
  expect(location.origin + location.pathname).toBe("https://auth.hackclub.com/oauth/authorize");
  expect(location.searchParams.get("scope")).toBe("openid slack_id");
});

it("does not short-circuit the OAuth callback when the one-time password is configured", async () => {
  configure();
  const req = new NextRequest("https://orry.example/auth/callback?state=bad&code=abc");
  const res = await GET(req);
  expect(new URL(res.headers.get("location")!).searchParams.get("m")).toBe("retry");
});
