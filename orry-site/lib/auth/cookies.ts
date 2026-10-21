/* The short signed cookies of the sign-in and invite flows, and the redirect helper route handlers use. */
import { NextResponse } from "next/server";
import { ABSOLUTE_MS, baseUrl, cookieBase, cookieNames, SHORT_COOKIE_MS } from "./config";
import { sign, unsign } from "./crypto";

/** OAuth state: random state and nonce, the provider, the return path and, for an invite, its ID (kept server-side, 7.6 step 3). */
export type OAuthState = { s: string; n: string; p: "hca" | "dev"; r: string; i?: number };
/** Invite cookie: the invite ID (0 = the link matched nothing), and the Slack ID of a wrong-account attempt. */
export type InviteCookie = { i: number; w?: string };
/** One-time message for the no-access page. */
export type Flash = { m: string; sid?: string };

export const encode = {
  oauth: (v: OAuthState) => sign(v, SHORT_COOKIE_MS),
  invite: (v: InviteCookie) => sign(v, SHORT_COOKIE_MS),
  flash: (v: Flash) => sign(v, 60_000)
};
export const decode = {
  oauth: (s?: string) => unsign<OAuthState>(s),
  invite: (s?: string) => unsign<InviteCookie>(s),
  flash: (s?: string) => unsign<Flash>(s)
};

export function redirectTo(path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, baseUrl() + "/"), 303);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(cookieNames.session, token, cookieBase(Math.floor(ABSOLUTE_MS / 1000)));
}
export function clearCookie(res: NextResponse, name: string) {
  res.cookies.set(name, "", cookieBase(0));
}
export function setShort(res: NextResponse, name: string, value: string, maxAgeMs = SHORT_COOKIE_MS) {
  res.cookies.set(name, value, cookieBase(Math.floor(maxAgeMs / 1000)));
}
