"use server";
/* The Profile panel's "Show me on the leaderboard" switch. Server actions carry Next's own Origin check; the
   session is checked again here. */
import { revalidatePath } from "next/cache";
import { setShowOnLeaderboard } from "@/lib/models";
import { requireSession } from "@/lib/session";

export async function saveShowOnLeaderboard(show: boolean): Promise<{ ok: boolean; show: boolean }> {
  const s = await requireSession("helper");
  try {
    await setShowOnLeaderboard(s, !!show);
    revalidatePath("/rewards");
    revalidatePath("/leaderboard");
    return { ok: true, show: !!show };
  } catch {
    return { ok: false, show: !show };
  }
}
