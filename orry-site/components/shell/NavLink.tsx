"use client";
/* A sidebar link that marks itself aria-current="page" from the pathname. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function isActive(pathname: string, href: string, match: string[] = []): boolean {
  const roots = [href, ...match];
  return roots.some(r => pathname === r || pathname.startsWith(r + "/"));
}

export function NavLink({ href, match, children, route }: { href: string; match?: string[]; children: ReactNode; route: string }) {
  const pathname = usePathname() ?? "";
  const on = isActive(pathname, href, match);
  return (
    <Link className="section-link" href={href} data-route={route} aria-current={on ? "page" : undefined}>
      {children}
    </Link>
  );
}

/** #view gets the mockup's view class from the route: v-board for the board and tickets, v-insights for the rest. */
export function ViewHost({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const kind = pathname.startsWith("/board") || pathname.startsWith("/tickets") ? "v-board" : "v-insights";
  return <div id="view" className={"view " + kind} tabIndex={-1}>{children}</div>;
}
