/* POST /api/auth/sign-out. Sign out is a POST (PLAN 7.3); the proxy has already checked Origin. */
import type { NextRequest } from "next/server";
import { cookieNames } from "@/lib/auth/config";
import { clearCookie, redirectTo } from "@/lib/auth/cookies";
import { logEvent } from "@/lib/auth/events";
import { accountById, deleteSessionByToken, sessionByToken } from "@/lib/auth/store";
import { originAllowed } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!originAllowed(req.headers)) return new Response("Bad origin", { status: 403 });
  const raw = req.cookies.get(cookieNames.session)?.value;
  if (raw) {
    const s = sessionByToken(raw);
    const a = s ? accountById(s.accountId) : null;
    deleteSessionByToken(raw);
    if (a) logEvent("sign_out", a.slackId, { subject: a.slackId });
  }
  const res = redirectTo("/sign-in?m=out");
  clearCookie(res, cookieNames.session);
  return res;
}
