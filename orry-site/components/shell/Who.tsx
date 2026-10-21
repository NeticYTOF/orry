/* A person, in the mockup's markup, rendered in both forms. The data-people attribute picks one with CSS:
   names mode shows "Name" over "@handle"; usernames mode shows "@handle" alone. Server-safe (no hooks). */
import type { ReactNode } from "react";

export type WhoPerson = { handle: string; name: string };

export function Who({ p, you, className }: { p: WhoPerson; you?: boolean; className?: string }) {
  const youTag = you ? <i className="you">you</i> : null;
  const hasName = !!p.name && p.name !== p.handle;
  return (
    <span className={"who" + (className ? " " + className : "")}>
      <b>
        {hasName ? <span className="pp-name">{p.name}</span> : null}
        <span className={hasName ? "pp-handle" : undefined}>@{p.handle}</span>
        {youTag}
      </b>
      {hasName ? <small className="pp-name">@{p.handle}</small> : null}
    </span>
  );
}

/** Inline text form: "Juno Baker" or "@pixel-otter". */
export function PersonText({ p, bold }: { p: WhoPerson; bold?: boolean }): ReactNode {
  const hasName = !!p.name && p.name !== p.handle;
  const inner = hasName
    ? <><span className="pp-name">{p.name}</span><span className="pp-handle">@{p.handle}</span></>
    : <>@{p.handle}</>;
  return bold ? <b>{inner}</b> : <span>{inner}</span>;
}

export function initials(p: WhoPerson): string {
  const base = p.name && p.name !== p.handle ? p.name : p.handle;
  return base.split(/[\s-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("") || "?";
}
