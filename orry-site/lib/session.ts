/* The signed-in person, for pages and route handlers. Every guarded page calls requireSession(); every guarded
   route handler calls requireApiSession(). Both go through the one guard in lib/auth/guard.ts. */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { cookieNames } from "./auth/config";
import { checkSession, deniedRedirect, type Role, type Session } from "./auth/guard";
import { originAllowed } from "./security";

export type { Role, Session };

async function rawToken(): Promise<string | undefined> {
  return (await cookies()).get(cookieNames.session)?.value;
}
async function currentPath(): Promise<string> {
  return (await headers()).get("x-orry-path") ?? "";
}

/** The signed-in person, or null. Never redirects. */
export async function getSession(): Promise<Session | null> {
  const r = await checkSession(await rawToken(), "helper", await currentPath());
  return r.ok ? r.session : null;
}

/**
 * For pages and server actions. Returns the session, or redirects: to /sign-in when signed out or the session ended,
 * or to the no-access page when the person lacks the role or Orry cannot be asked.
 */
export async function requireSession(min: Role = "helper"): Promise<Session> {
  const r = await checkSession(await rawToken(), min, await currentPath());
  if (r.ok) return r.session;
  redirect(deniedRedirect(r.reason));
}

/**
 * For route handlers. Checks Origin on every non-GET request, then the session.
 * Returns the session, or a JSON response to send back as it is (401 signed out, 403 no access or bad origin).
 */
export async function requireApiSession(req: Request, min: Role = "helper"): Promise<Session | NextResponse> {
  if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req.headers)) {
    return NextResponse.json({ error: "bad_origin", message: "This request did not come from the site." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const path = new URL(req.url).pathname;
  const r = await checkSession(await rawToken(), min, path);
  if (r.ok) return r.session;
  const status = r.reason === "none" || r.reason === "ended" || r.reason === "off" ? 401 : 403;
  return NextResponse.json({ error: r.reason, redirect: deniedRedirect(r.reason) }, { status, headers: { "Cache-Control": "no-store" } });
}

export const isResponse = (x: unknown): x is NextResponse => x instanceof Response;
