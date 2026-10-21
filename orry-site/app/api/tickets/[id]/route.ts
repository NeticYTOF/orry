/* GET /api/tickets/:id: the ticket sheet and page data (PLAN 4.2). Sensitive question text is withheld here; it is
   only returned by POST /api/tickets/:id/reveal. The number is the only identifier in the URL (PLAN 2.4 rule 1). */
import { NextResponse, type NextRequest } from "next/server";
import { isResponse, requireApiSession } from "@/lib/session";
import { takeToken } from "@/lib/security";
import { getTicketModel } from "@/lib/models/ticket";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" };

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession(req, "helper");
  if (isResponse(s)) return s;
  const { id } = await ctx.params;
  if (!/^\d{1,9}$/.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  if (!takeToken(`ticket:${s.slackId}`, 20 / 60, 20)) {
    return NextResponse.json({ error: "rate_limited", message: "Too many tickets opened in a minute. Wait a moment." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "10" } });
  }
  const model = await getTicketModel(s, Number(id));
  if (!model) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  return NextResponse.json(model, { headers: NO_STORE });
}
