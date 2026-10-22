/* GET /invite/<token> (PLAN 7.6 step 2). Looks the token's hash up, keeps the invite ID in a signed 10-minute
   cookie and redirects to /invite, so the token leaves the address bar and the history. Every link, good or bad,
   gets the same work and the same answer; a global limit of 20 a minute keeps out the noise. */
import type { NextRequest } from "next/server";
import { cookieNames } from "@/lib/auth/config";
import { encode, redirectTo, setShort } from "@/lib/auth/cookies";
import { inviteByToken } from "@/lib/auth/store";
import { takeToken } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!takeToken("invite-open", 20 / 60, 20)) {
    const res = redirectTo("/invite?m=slow");
    return res;
  }
  const t = typeof token === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : "x".repeat(43);
  const inv = inviteByToken(t);
  const res = redirectTo("/invite");
  setShort(res, cookieNames.invite, encode.invite({ i: inv ? inv.id : 0 }));
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
