/* Dev identity provider, authorization endpoint. GET with a login_hint for a known fake account issues a code at
   once (the person already picked the account on /sign-in); without one it shows the account chooser.
   POST comes from the chooser. 404 unless ORRY_DEV_AUTH=1. */
import { NextResponse, type NextRequest } from "next/server";
import { devAuthEnabled } from "@/lib/auth/config";
import { checkAuthorize, devAccount, issueCode, type AuthorizeParams } from "@/lib/auth/dev-idp";
import { originAllowed } from "@/lib/security";

export const dynamic = "force-dynamic";

const read = (g: (k: string) => string | null): AuthorizeParams => ({
  clientId: g("client_id") ?? "", redirectUri: g("redirect_uri") ?? "", state: g("state") ?? "",
  nonce: g("nonce") ?? "", responseType: g("response_type") ?? ""
});

function go(url: string) {
  return NextResponse.redirect(url, 303);
}

export async function GET(req: NextRequest) {
  if (!devAuthEnabled()) return new NextResponse("Not found", { status: 404 });
  const q = req.nextUrl.searchParams;
  const p = read(k => q.get(k));
  const err = checkAuthorize(p);
  if (err) return new NextResponse("Dev identity provider: " + err, { status: 400 });
  const hint = q.get("login_hint");
  if (hint && devAccount(hint)) return go(issueCode(p, hint));
  const u = new URL("/dev-idp", req.nextUrl.origin);
  for (const k of ["client_id", "redirect_uri", "state", "nonce", "response_type", "scope"]) { const v = q.get(k); if (v) u.searchParams.set(k, v); }
  return go(u.toString());
}

export async function POST(req: NextRequest) {
  if (!devAuthEnabled()) return new NextResponse("Not found", { status: 404 });
  if (!originAllowed(req.headers)) return new NextResponse("Bad origin", { status: 403 });
  const f = await req.formData();
  const p = read(k => { const v = f.get(k); return typeof v === "string" ? v : null; });
  const err = checkAuthorize(p);
  if (err) return new NextResponse("Dev identity provider: " + err, { status: 400 });
  if (f.get("deny") === "1") {
    const u = new URL(p.redirectUri); u.searchParams.set("error", "access_denied"); u.searchParams.set("state", p.state);
    return go(u.toString());
  }
  const sub = String(f.get("sub") || "");
  if (!devAccount(sub)) return new NextResponse("Dev identity provider: unknown account", { status: 400 });
  return go(issueCode(p, sub));
}
