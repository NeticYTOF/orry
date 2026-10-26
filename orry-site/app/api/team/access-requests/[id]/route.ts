/* POST /api/team/access-requests/<id> {decision}: approve or deny one verified Hack Club identity. */
import { z } from "zod";
import { idParam, organizerAction } from "@/lib/auth/api";
import { decideAccessRequest } from "@/lib/auth/team";

export const dynamic = "force-dynamic";

const Body = z.object({ decision: z.enum(["approve", "deny"]) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return organizerAction(req, Body, (s, b) => {
    decideAccessRequest({ slackId: s.slackId, role: s.role }, idParam(id), b.decision);
    return {};
  });
}
