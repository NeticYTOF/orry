/* The header every page opens with: a small kicker chip, the title (pixel, with the heading's corner marks), an optional
   note under it and optional chips or actions on the right. Server-safe. Spec: reports/orry-redesign-2026-10-20/SPEC.md */
import type { ReactNode } from "react";

export function PageHead({ kicker, title, note, side, id = "h-title" }: { kicker?: string; title: ReactNode; note?: ReactNode; side?: ReactNode; id?: string }) {
  return (
    <header className="ph">
      <div className="ph-main">
        {kicker ? <p className="ph-kick"><span className="eyebrow">{kicker}</span></p> : null}
        <h1 className="ph-title" id={id}>{title}</h1>
        {note ? <p className="ph-note">{note}</p> : null}
      </div>
      {side ? <div className="ph-side">{side}</div> : null}
    </header>
  );
}
