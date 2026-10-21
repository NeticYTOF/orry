/* Page tabs as plain links (?tab=key): no script, the address keeps the tab, back and forward work, and the server only
   renders the panel that is showing. Server-safe. */
import Link from "next/link";
import type { ReactNode } from "react";

export type TabDef = { key: string; label: ReactNode; n?: number | string | null };

export function TabNav({ label, tabs, current, href, className = "" }: {
  label: string; tabs: TabDef[]; current: string; href: (key: string) => string; className?: string;
}) {
  return (
    <nav className={"tabs scroll " + className} aria-label={label}>
      {tabs.map(t => (
        <Link key={t.key} href={href(t.key)} scroll={false} aria-current={t.key === current ? "page" : undefined}>
          {t.label}{t.n != null && t.n !== "" ? <span className="n">{t.n}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** The tab named by ?tab=, or the first tab when it is missing or unknown. */
export const pickTab = (tabs: TabDef[], want: string | string[] | undefined): string => {
  const w = typeof want === "string" ? want : "";
  return tabs.some(t => t.key === w) ? w : tabs[0]!.key;
};
