/* Runs before every route (PLAN 7.3, 7.4). Cheap checks only; the full session check is the guard each page
   and route handler calls (lib/session.ts):
   - Origin check on every non-GET request
   - default deny: a guarded path with no session cookie goes to /sign-in (pages) or gets 401 (API)
   - a global token bucket for anonymous traffic
   - security headers and a per-request CSP nonce */
import { NextResponse, type NextRequest } from "next/server";
import { cookieBase, cookieNames, devAuthEnabled, secureCookies } from "./lib/auth/config";
import { accessFor } from "./lib/auth/routes";
import { originAllowed, securityHeaders, takeToken } from "./lib/security";

/* OAuth token endpoints are called server to server, with no browser Origin; they authenticate the client instead. */
const ORIGIN_EXEMPT = new Set(["/dev-idp/token"]);

function allowedHost(req: NextRequest): boolean {
  const list = (process.env.ORRY_ALLOWED_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")].filter((h): h is string => !!h).map(h => h.toLowerCase());
  return hosts.some(h => list.includes(h));
}

function finish(res: NextResponse, nonce: string): NextResponse {
  const dev = process.env.NODE_ENV !== "production";
  for (const [k, v] of Object.entries(securityHeaders(nonce, { dev, https: secureCookies() }))) res.headers.set(k, v);
  return res;
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const json = (status: number, body: object) => finish(NextResponse.json(body, { status }), nonce);

  if (!allowedHost(req)) return json(421, { error: "wrong_host" });

  if (path === "/dev-idp" || path.startsWith("/dev-idp/")) {
    if (!devAuthEnabled()) return finish(new NextResponse("Not found", { status: 404 }), nonce);
  }

  const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (write && !ORIGIN_EXEMPT.has(path) && !originAllowed(req.headers)) {
    return json(403, { error: "bad_origin", message: "This request did not come from the site." });
  }

  const hasSession = !!req.cookies.get(cookieNames.session)?.value;
  if (!hasSession && !takeToken("anon", 20, 40)) return json(429, { error: "slow_down" });

  const access = accessFor(path);
  const sp = new URLSearchParams(req.nextUrl.search); sp.delete("_rsc");
  const back = path + (sp.size ? "?" + sp.toString() : "");
  const isApi = path.startsWith("/api/");
  if (access !== "public" && !hasSession) {
    if (isApi) return json(401, { error: "none", redirect: "/sign-in" });
    const res = NextResponse.redirect(new URL("/sign-in", req.url), 303);
    if (req.method === "GET") res.cookies.set(cookieNames.next, back, cookieBase(600));
    return finish(res, nonce);
  }

  const dev = process.env.NODE_ENV !== "production";
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("x-orry-path", path);
  headers.set("content-security-policy", securityHeaders(nonce, { dev, https: secureCookies() })["Content-Security-Policy"]);
  const res = NextResponse.next({ request: { headers } });
  /* Remember the page so a sign-in can come back to it. The cookie, not a query parameter, carries it (7.2 step 1). */
  const prefetch = req.headers.get("next-router-prefetch") || req.headers.get("purpose") === "prefetch";
  if (access !== "public" && !isApi && req.method === "GET" && !prefetch) {
    res.cookies.set(cookieNames.next, back, cookieBase(600));
  }
  return finish(res, nonce);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|fonts/|sprites/|img/|favicon.ico|icon.svg|robots.txt).*)"
  ]
};
