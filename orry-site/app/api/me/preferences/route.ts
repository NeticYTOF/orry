/* POST /api/me/preferences: saves display preferences as cookies, so the server paints the next page right.
   Body (JSON or form): any of theme (dark|light), people (name|handle), density (standard|roomy). */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { secureCookies } from "@/lib/auth/config";
import { PREF_COOKIES } from "@/components/shell/prefs-server";
import { isResponse, requireApiSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  theme: z.enum(["dark", "light"]).optional(),
  people: z.enum(["name", "handle"]).optional(),
  density: z.enum(["standard", "roomy"]).optional()
}).strict();

export async function POST(req: NextRequest) {
  const s = await requireApiSession(req, "helper");
  if (isResponse(s)) return s;
  let raw: unknown;
  try {
    raw = (req.headers.get("content-type") || "").includes("application/json")
      ? await req.json()
      : Object.fromEntries((await req.formData()).entries());
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const p = Body.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: "bad_value", message: "Unknown preference or value." }, { status: 400 });
  const res = NextResponse.json({ ok: true, saved: p.data }, { headers: { "Cache-Control": "no-store" } });
  for (const [k, v] of Object.entries(p.data)) {
    if (!v) continue;
    res.cookies.set(PREF_COOKIES[k as keyof typeof PREF_COOKIES], v, { path: "/", sameSite: "lax", secure: secureCookies(), httpOnly: false, maxAge: 365 * 86400 });
  }
  return res;
}
