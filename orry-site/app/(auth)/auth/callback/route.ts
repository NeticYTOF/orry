/* GET /auth/callback (PLAN 7.2 steps 2-7). Rejects before any outbound call when the state cookie is missing
   or does not match. Then the provider checks the ID token, and completeSignIn applies both locks. */
import type { NextRequest } from "next/server";
import { cookieNames } from "@/lib/auth/config";
import { clearCookie, decode, encode, redirectTo, setSessionCookie, setShort } from "@/lib/auth/cookies";
import { logEvent } from "@/lib/auth/events";
import { completeSignIn } from "@/lib/auth/flow";
import { OidcError } from "@/lib/auth/oidc";
import { getProvider, redirectUri } from "@/lib/auth/providers";
import { safeReturnPath } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const st = decode.oauth(req.cookies.get(cookieNames.oauth)?.value);
  const done = (path: string) => { const r = redirectTo(path); clearCookie(r, cookieNames.oauth); return r; };

  if (!st || !q.get("state") || q.get("state") !== st.s) return done("/sign-in?m=retry");
  if (q.get("error")) return done(st.i ? "/invite" : "/sign-in?m=cancelled");
  const code = q.get("code");
  const provider = getProvider(st.p);
  if (!code || !provider) return done("/sign-in?m=failed");

  let identity;
  try {
    identity = await provider.callback({ code, nonce: st.n, redirectUri: redirectUri() });
  } catch (e) {
    const why = e instanceof OidcError ? e.code : "provider_error";
    logEvent("sign_in_refused", null, { reason: "oidc_" + why });
    return done("/sign-in?m=failed");
  }

  const old = req.cookies.get(cookieNames.session)?.value ?? null;
  const out = await completeSignIn(identity, { inviteId: st.i ?? null, oldToken: old });
  if (out.ok) {
    const res = done(safeReturnPath(st.r));
    setSessionCookie(res, out.token);
    clearCookie(res, cookieNames.invite);
    clearCookie(res, cookieNames.next);
    return res;
  }

  switch (out.code) {
    case "invite_wrong_account": {
      const res = done("/invite");
      setShort(res, cookieNames.invite, encode.invite({ i: st.i!, w: out.slackId }));
      return res;
    }
    case "invite_expired": case "invite_used": case "invite_cancelled": case "invite_missing":
      return done("/invite");
    case "invite_account_exists": {
      const res = done("/sign-in?m=exists");
      clearCookie(res, cookieNames.invite);
      return res;
    }
    case "roster": case "offline": {
      const res = done("/no-access?m=" + out.code);
      setShort(res, cookieNames.flash, encode.flash({ m: out.code, sid: out.slackId }), 60_000);
      clearCookie(res, cookieNames.invite);
      return res;
    }
    case "no_slack": case "bad_slack": return done("/sign-in?m=noslack");
    case "no_account": return done("/sign-in?m=noaccount");
    case "off": return done("/sign-in?m=off");
    case "sub_mismatch": return done("/sign-in?m=mismatch");
  }
}
