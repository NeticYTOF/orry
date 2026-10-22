/* The signed-in area. The guard runs here for the first paint, and every page in (app) also calls
   requireSession() itself, because a layout is not re-rendered on client-side navigation. */
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { readPrefs } from "@/components/shell/prefs-server";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession("helper");
  const prefs = await readPrefs();
  return <AppShell session={session} light={prefs.theme === "light"}>{children}</AppShell>;
}
