"use client";
/* A client-side tab bar (mockups/stats.html ORRY.tabs): buttons with role=tab in the kit's .tabs, panels #tp-<name>
   rendered on the server. Arrow keys, Home and End move between tabs; the hash (#people) keeps the choice for a
   pasted link. (/orry itself uses link tabs; this one is for pages that render every panel.) */
import { useEffect, useRef, useState } from "react";

export function StatsTabs({ tabs, label }: { tabs: Array<{ key: string; label: string }>; label: string }) {
  const [cur, setCur] = useState(tabs[0].key);
  const focusNext = useRef(false);

  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (tabs.some(t => t.key === h)) setCur(h);
  }, [tabs]);

  useEffect(() => {
    for (const t of tabs) { const p = document.getElementById(`tp-${t.key}`); if (p) p.hidden = t.key !== cur; }
    if (focusNext.current) { document.getElementById(`tab-${cur}`)?.focus(); focusNext.current = false; }
  }, [cur, tabs]);

  const show = (k: string, focus = false) => {
    focusNext.current = focus;
    setCur(k);
    try { window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${k}`); } catch { /* ignore */ }
  };

  return (
    <div className="tabs scroll or-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button key={t.key} type="button" role="tab" id={`tab-${t.key}`} aria-controls={`tp-${t.key}`} aria-selected={cur === t.key} tabIndex={cur === t.key ? 0 : -1}
          onClick={() => show(t.key)}
          onKeyDown={e => {
            const n = tabs.length;
            const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -i : e.key === "End" ? n - 1 - i : null;
            if (d === null) return;
            e.preventDefault();
            show(tabs[(i + d + n) % n].key, true);
          }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
