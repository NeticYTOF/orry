/* Dev identity provider, JWKS: the public key that signs its ID tokens. 404 unless ORRY_DEV_AUTH=1. */
import { NextResponse } from "next/server";
import { devAuthEnabled } from "@/lib/auth/config";
import { devJwks } from "@/lib/auth/dev-idp";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!devAuthEnabled()) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(await devJwks(), { headers: { "Cache-Control": "no-store" } });
}
