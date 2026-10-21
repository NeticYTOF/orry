/* /leaderboard moved into Weekly rewards (/rewards). */
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function LeaderboardMoved({ searchParams }: { searchParams: SP }) {
  await requireSession("helper");
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "ranking" });
  for (const k of ["period", "measure"]) if (typeof sp[k] === "string") q.set(k, sp[k] as string);
  redirect(`/rewards${q.size ? `?${q}` : ""}`);
}
