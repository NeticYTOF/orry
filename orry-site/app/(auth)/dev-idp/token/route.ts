/* Dev identity provider, token endpoint: exchanges a one-time code for a signed RS256 ID token. 404 unless ORRY_DEV_AUTH=1. */
import { NextResponse, type NextRequest } from "next/server";
import { devAuthEnabled } from "@/lib/auth/config";
import { exchangeCode } from "@/lib/auth/dev-idp";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!devAuthEnabled()) return new NextResponse("Not found", { status: 404 });
  let f: FormData;
  try { f = await req.formData(); } catch { return NextResponse.json({ error: "invalid_request" }, { status: 400 }); }
  const s = (k: string) => String(f.get(k) ?? "");
  const out = await exchangeCode({ grantType: s("grant_type"), code: s("code"), redirectUri: s("redirect_uri"), clientId: s("client_id"), clientSecret: s("client_secret") });
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.error === "invalid_client" ? 401 : 400, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(out.ok, { headers: { "Cache-Control": "no-store" } });
}
