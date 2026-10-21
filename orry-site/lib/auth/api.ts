/* Shared wrapper for the /api/team/* route handlers: organizer guard (with the Origin check), JSON body, and
   plain-language errors. */
import { NextResponse } from "next/server";
import type { z } from "zod";
import { isResponse, requireApiSession, type Session } from "../session";
import { TeamError } from "./team";

const noStore = { "Cache-Control": "no-store" };

export async function organizerAction<S extends z.ZodType>(
  req: Request,
  schema: S | null,
  fn: (s: Session, body: z.infer<S>) => Promise<unknown> | unknown
): Promise<NextResponse> {
  const s = await requireApiSession(req, "organizer");
  if (isResponse(s)) return s;
  let body: unknown = {};
  if (schema) {
    try { body = await req.json(); } catch { return NextResponse.json({ error: "bad_body", message: "The request was not JSON." }, { status: 400, headers: noStore }); }
    const p = schema.safeParse(body);
    if (!p.success) return NextResponse.json({ error: "bad_body", message: "Some fields are missing or wrong." }, { status: 400, headers: noStore });
    body = p.data;
  }
  try {
    const out = await fn(s, body as z.infer<S>);
    return NextResponse.json({ ok: true, ...(out && typeof out === "object" ? out : {}) }, { headers: noStore });
  } catch (e) {
    if (e instanceof TeamError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status, headers: noStore });
    console.error("team action failed:", (e as Error).message);
    return NextResponse.json({ error: "failed", message: "That did not work. Nothing was changed." }, { status: 500, headers: noStore });
  }
}

export const idParam = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new TeamError("not_found", "Not found.", 404);
  return n;
};
