/* The one card every signed-out screen sits in: the LOADOUT lockup and the theme switch in a header strip, then one
   heading, the explanation and one action. Server component (it reads the theme cookie for the switch). */
import type { ReactNode } from "react";
import { Brand } from "@/components/shell/Brand";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { readPrefs } from "@/components/shell/prefs-server";

export async function AuthCard({ title, children, wide, bodyId }: { title: ReactNode; children: ReactNode; wide?: boolean; bodyId?: string }) {
  const prefs = await readPrefs();
  return (
    <section className={"panel au-card" + (wide ? " wide" : "")} aria-labelledby="h-title">
      <div className="panel-h au-h">
        <Brand href="/" />
        <ThemeToggle light={prefs.theme === "light"} />
      </div>
      <div className="au-b" id={bodyId}>
        <h1 className="au-title" id="h-title">{title}</h1>
        {children}
      </div>
    </section>
  );
}
