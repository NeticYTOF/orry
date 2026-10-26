/* POST /api/auth/start: begins a sign-in (PLAN 7.2 step 1). Form fields: provider ("hca" or "dev"),
   as (dev only: which fake account), invite ("1" to accept the invite in the invite cookie).
   Keeps state, nonce, the return path and the invite ID in a signed 10-minute cookie, then redirects to the provider. */
import type { NextRequest } from "next/server";
import { cookieNames } from "@/lib/auth/config";
import { clearCookie, decode, encode, redirectTo, setShort } from "@/lib/auth/cookies";
import { randomToken } from "@/lib/auth/crypto";
import { devAccount } from "@/lib/auth/dev-idp";
import { getProvider, primaryProviderId, redirectUri } from "@/lib/auth/providers";
import { inviteById, shownState } from "@/lib/auth/store";
import { originAllowed, safeReturnPath } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!originAllowed(req.headers)) return redirectTo("/sign-in?m=failed");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    form = new FormData();
  }
  const wanted = String(form.get("provider") || primaryProviderId() || "");
  const provider = getProvider(wanted);
  if (!provider) return redirectTo("/sign-in?m=unavailable");

  let inviteId: number | undefined;
  if (form.get("invite") === "1") {
    const c = decode.invite(req.cookies.get(cookieNames.invite)?.value);
    const inv = c && c.i ? inviteById(c.i) : null;
    /* re-checked here: an invite that expired between page load and Continue is refused */
    if (!inv || shownState(inv) !== "pending") return redirectTo("/invite");
    inviteId = inv.id;
  }

  const hintSub = provider.id === "dev" ? String(form.get("as") || "") : "";
  const loginHint = hintSub && devAccount(hintSub) ? hintSub : undefined;
  const state = randomToken(24),
    nonce = randomToken(24);
  const r = safeReturnPath(req.cookies.get(cookieNames.next)?.value);
  const res = redirectTo(provider.authorizeUrl({ state, nonce, redirectUri: redirectUri(), loginHint }));
  setShort(
    res,
    cookieNames.oauth,
    encode.oauth({ s: state, n: nonce, p: provider.id, r, ...(inviteId ? { i: inviteId } : {}) }),
  );
  clearCookie(res, cookieNames.next);
  return res;
}
