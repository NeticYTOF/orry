/* POST /api/auth/sign-out-all: Settings, "Sign out everywhere". Ends every session of the signed-in person.
   A form post gets a redirect to the sign-in page; a fetch with Accept: application/json gets JSON. */
import { NextResponse, type NextRequest } from "next/server";
import { cookieNames } from "@/lib/auth/config";
import { clearCookie, redirectTo } from "@/lib/auth/cookies";
import { signOutEverywhere } from "@/lib/auth/team";
import { isResponse, requireApiSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const s = await requireApiSession(req, "helper");
  if (isResponse(s)) return s;
  const ended = signOutEverywhere(s.accountId, s.slackId);
  const wantsJson = (req.headers.get("accept") || "").includes("application/json");
  const res = wantsJson
    ? NextResponse.json({ ok: true, ended, redirect: "/sign-in?m=out" }, { headers: { "Cache-Control": "no-store" } })
    : redirectTo("/sign-in?m=out");
  clearCookie(res, cookieNames.session);
  return res;
}
