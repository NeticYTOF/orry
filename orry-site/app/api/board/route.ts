/* GET /api/board?view=human&since=<version>: the board's polling payload (PLAN 4.1 Live updates, 6.4).
   The browser polls every 30 s with If-None-Match; an unchanged board answers 304. `since` is the version the
   browser shows; the answer then carries "n changes" so rows never move under the reader until Apply.
   Signed-in helpers and organizers only; never cached (the rows hold participants' text). */
import { NextResponse, type NextRequest } from "next/server";
import { isResponse, requireApiSession } from "@/lib/session";
import { takeToken } from "@/lib/security";
import { boardChanges, getBoardModel, rememberBoard } from "@/lib/models/board";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" };

export async function GET(req: NextRequest) {
  const s = await requireApiSession(req, "helper");
  if (isResponse(s)) return s;
  if (!takeToken(`board:${s.slackId}`, 1, 60)) {
    return NextResponse.json({ error: "rate_limited", message: "Too many refreshes. Wait a moment." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "30" } });
  }
  const url = new URL(req.url);
  const view = url.searchParams.get("view");
  const since = url.searchParams.get("since");
  const model = await getBoardModel(s, { view });
  rememberBoard(model);
  const etag = `W/"${model.version}-${model.freshness.tag.replace(/[^A-Z0-9:]+/gi, "-")}-${model.view}-${s.role}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...NO_STORE, ETag: etag } });
  const changes = since && /^[a-f0-9]{16}$/.test(since) && since !== model.version ? boardChanges(since, model) : null;
  return NextResponse.json({ version: model.version, changes, model }, { headers: { ...NO_STORE, ETag: etag, Vary: "Cookie" } });
}
