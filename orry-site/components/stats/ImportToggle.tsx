"use client";
/* "Include imported tickets": one toggle for every number on the page (PLAN 4.3 One import rule). The numbers are
   computed on the server, so the toggle reloads the page with ?imported=1, keeping the week and the open tab. */
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function ImportToggle({ on, label, week, base = "/orry" }: { on: boolean; label: string; week: string; base?: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  return (
    <button className="btn tog" type="button" id="incImported" aria-pressed={on} aria-labelledby="lbl-coh incLbl" aria-busy={busy || undefined}
      onClick={() => {
        const q = new URLSearchParams(window.location.search);
        q.set("week", week);
        if (!on) q.set("imported", "1"); else q.delete("imported");
        start(() => router.push(`${base}?${q}`, { scroll: false }));
      }}>
      <span id="incLbl">{label}</span>
    </button>
  );
}
