/* POST /api/team/accounts/<id>/role {role}: make someone helper or organizer. Not yourself; never the last organizer. */
import { z } from "zod";
import { idParam, organizerAction } from "@/lib/auth/api";
import { setRole } from "@/lib/auth/team";

export const dynamic = "force-dynamic";

const Body = z.object({ role: z.enum(["helper", "organizer"]) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return organizerAction(req, Body, (s, b) => { setRole({ slackId: s.slackId, role: s.role }, idParam(id), b.role); return {}; });
}
