/* POST /api/team/accounts/<id>/status {status: on|off}: turn an account off (ends every session) or on. Not yourself; never the last organizer. */
import { z } from "zod";
import { idParam, organizerAction } from "@/lib/auth/api";
import { setStatus } from "@/lib/auth/team";

export const dynamic = "force-dynamic";

const Body = z.object({ status: z.enum(["on", "off"]) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return organizerAction(req, Body, (s, b) => { setStatus({ slackId: s.slackId, role: s.role }, idParam(id), b.status); return {}; });
}
