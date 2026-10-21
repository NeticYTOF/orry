"use client";
/* A sensitive ticket's question: collapsed until the helper chooses "Show message". The text comes only from
   POST /api/tickets/:id/reveal, which writes the access log row first (PLAN 2.4 rule 4). Never cached or stored.
   Markup matches TicketView's question (.tk-quote, app/ui/ticket.css). */
import { useRef, useState } from "react";
import { announce } from "@/components/viz/live";

export function RevealQuestion({ path, note, caption, safeguarding, textId }: { path: string; note: string; caption: string; safeguarding: string | null; textId: string }) {
  const [state, setState] = useState<{ text: string; shown: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textRef = useRef<HTMLParagraphElement>(null);

  async function reveal() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || typeof j.text !== "string") { setErr(j.message ?? "The message could not be shown right now. Nothing was logged as shown."); return; }
      setState({ text: j.text, shown: j.note ?? "Shown to you. This is logged." });
      announce("Message shown. This is logged.");
      requestAnimationFrame(() => textRef.current?.focus());
    } catch {
      setErr("The message could not be shown right now. Nothing was logged as shown.");
    } finally { setBusy(false); }
  }

  if (state) {
    return (
      <figure className="tk-quote">
        <blockquote><p id={textId} ref={textRef} tabIndex={-1}>{state.text}</p></blockquote>
        <figcaption>{caption}</figcaption>
        <p className="tk-qnote">{state.shown}</p>
      </figure>
    );
  }
  return (
    <figure className="tk-quote withheld">
      <blockquote><p>{note}</p></blockquote>
      <figcaption>{caption}</figcaption>
      <div className="tk-reveal">
        <button className="btn sm" type="button" aria-expanded="false" aria-describedby={`${textId}-log`} disabled={busy} onClick={reveal}>{busy ? "Showing…" : "Show message"}</button>
        <span className="tk-qnote" id={`${textId}-log`}>Every reveal is logged on the ticket.</span>
      </div>
      {err ? <p className="tk-qnote" role="alert">{err}</p> : null}
      {safeguarding ? <p className="tk-qnote">{safeguarding}</p> : null}
    </figure>
  );
}
