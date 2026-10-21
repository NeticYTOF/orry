/* GET /api/team/suggest?q=: Slack usernames for the invite form (active, non-bot members, from searchSlackUsers). */
import { NextResponse } from "next/server";
import { getDataSource } from "@/lib/data";
import { isResponse, requireApiSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const s = await requireApiSession(req, "organizer");
  if (isResponse(s)) return s;
  const q = (new URL(req.url).searchParams.get("q") || "").replace(/^@/, "").trim().slice(0, 40);
  if (!q) return NextResponse.json({ people: [] }, { headers: { "Cache-Control": "no-store" } });
  try {
    const people = await getDataSource().searchSlackUsers(q, 8);
    return NextResponse.json({ people: people.map(p => ({ handle: p.handle, name: p.name })) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ people: [], message: "Slack names can't be read right now." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
