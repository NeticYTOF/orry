/* POST /api/team/invites {user, role, days}: an organizer creates an invite. The link comes back once. */
import { z } from "zod";
import { organizerAction } from "@/lib/auth/api";
import { baseUrl } from "@/lib/auth/config";
import { createInvite } from "@/lib/auth/team";

export const dynamic = "force-dynamic";

const Body = z.object({ user: z.string().min(1).max(80), role: z.enum(["helper", "organizer"]), days: z.coerce.number().int() });

export async function POST(req: Request) {
  return organizerAction(req, Body, async (s, b) => {
    const inv = await createInvite({ slackId: s.slackId, role: s.role }, b);
    return { invite: { id: inv.id, slackId: inv.slackId, handle: inv.handle, role: inv.role, expiresAt: inv.expiresAt }, link: `${baseUrl()}/invite/${inv.token}`, warning: inv.warning };
  });
}
