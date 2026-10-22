/* POST /api/team/invites/<id>/resend: "Send again". A new link for the same person and role; an open old one is cancelled. */
import { idParam, organizerAction } from "@/lib/auth/api";
import { baseUrl } from "@/lib/auth/config";
import { resendInvite } from "@/lib/auth/team";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return organizerAction(req, null, async s => {
    const inv = await resendInvite({ slackId: s.slackId, role: s.role }, idParam(id));
    return { invite: { id: inv.id, slackId: inv.slackId, handle: inv.handle, role: inv.role, expiresAt: inv.expiresAt }, link: `${baseUrl()}/invite/${inv.token}`, warning: inv.warning };
  });
}
