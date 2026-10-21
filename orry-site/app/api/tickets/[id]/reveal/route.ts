/* POST /api/tickets/:id/reveal: shows a sensitive ticket's text to the signed-in helper or organizer (PLAN 2.4 rule 4).
   requireApiSession checks Origin on this POST. The access log row is written before the text is read out, and the
   answer is never cached. The text is never logged. */
import { NextResponse, type NextRequest } from "next/server";
import { isResponse, requireApiSession } from "@/lib/session";
import { takeToken } from "@/lib/security";
import { revealTicket } from "@/lib/models/ticket";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private", Pragma: "no-cache" };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession(req, "helper");
  if (isResponse(s)) return s;
  const { id } = await ctx.params;
  if (!/^\d{1,9}$/.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  if (!takeToken(`reveal:${s.slackId}`, 10 / 60, 10)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "Retry-After": "30" } });
  }
  const r = await revealTicket(s, Number(id));
  if (r.ok) return NextResponse.json({ text: r.text, shownAt: r.shownAt, note: r.note }, { headers: NO_STORE });
  const status = r.reason === "not_found" ? 404 : r.reason === "forbidden" ? 403 : r.reason === "not_sensitive" ? 409 : 503;
  const message = r.reason === "not_sensitive" ? "This message is not hidden. Reload the ticket." : r.reason === "unavailable" ? "The message could not be shown right now. Nothing was logged as shown." : null;
  return NextResponse.json({ error: r.reason, message }, { status, headers: NO_STORE });
}
