/* Redeems the single-use bootstrap password into the site's normal, server-stored session. */
import type { NextRequest } from "next/server";
import { cookieNames } from "@/lib/auth/config";
import { redirectTo, setSessionCookie } from "@/lib/auth/cookies";
import { oneTimePasswordEnabled } from "@/lib/auth/config";
import {
  canTryOneTimePassword,
  recordOneTimePasswordFailure,
  redeemOneTimePassword,
  verifyOneTimePassword,
} from "@/lib/auth/one-time";
import { originAllowed } from "@/lib/security";
import { rosterRole } from "@/lib/auth/roster";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store, private" };

export async function POST(req: NextRequest) {
  if (!originAllowed(req.headers)) return new Response("Bad origin", { status: 403, headers: noStore });
  if (!oneTimePasswordEnabled()) return redirectTo("/sign-in?m=unavailable");
  const size = Number(req.headers.get("content-length") || 0);
  if (size > 2048) return new Response("Request too large", { status: 413, headers: noStore });
  if (!canTryOneTimePassword())
    return new Response("Too many attempts. Try again later.", {
      status: 429,
      headers: { ...noStore, "Retry-After": "3600" },
    });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    form = new FormData();
  }
  const password = String(form.get("password") || "");
  if (!verifyOneTimePassword(password)) {
    recordOneTimePasswordFailure();
    return redirectTo("/sign-in?m=failed");
  }

  const slackId = process.env.ORRY_SITE_OTP_SLACK_ID!;
  const roster = await rosterRole(slackId);
  if (roster === null || roster === "public") return redirectTo("/sign-in?m=offline");
  const old = req.cookies.get(cookieNames.session)?.value;
  const result = redeemOneTimePassword(password, old);
  if (!result.ok) return redirectTo(result.reason === "used" ? "/sign-in?m=used" : "/sign-in?m=failed");
  const res = redirectTo("/board");
  setSessionCookie(res, result.token);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
