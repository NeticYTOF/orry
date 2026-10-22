/* /stats moved to /orry (organizers only). The old address and its week and import options still work. */
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function StatsMoved({ searchParams }: { searchParams: SP }) {
  await requireSession("helper");
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const k of ["week", "imported"]) if (typeof sp[k] === "string") q.set(k, sp[k] as string);
  redirect(`/orry${q.size ? `?${q}` : ""}`);
}
