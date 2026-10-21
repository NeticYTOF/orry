/* POST /api/team/invites/<id>/cancel: kills an open invite at once. */
import { idParam, organizerAction } from "@/lib/auth/api";
import { cancelInvite } from "@/lib/auth/team";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return organizerAction(req, null, s => { cancelInvite({ slackId: s.slackId, role: s.role }, idParam(id)); return {}; });
}
