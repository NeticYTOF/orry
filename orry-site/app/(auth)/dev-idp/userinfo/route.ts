/* Dev identity provider, userinfo. 404 unless ORRY_DEV_AUTH=1. */
import { NextResponse, type NextRequest } from "next/server";
import { devAuthEnabled } from "@/lib/auth/config";
import { devUserinfo } from "@/lib/auth/dev-idp";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!devAuthEnabled()) return new NextResponse("Not found", { status: 404 });
  const auth = req.headers.get("authorization") || "";
  const info = auth.startsWith("Bearer ") ? devUserinfo(auth.slice(7)) : null;
  if (!info) return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  return NextResponse.json(info, { headers: { "Cache-Control": "no-store" } });
}
