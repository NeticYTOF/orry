"use client";
/* Tooltips for [data-tip] elements (chart columns, heat cells, the freshness tag), from mockups/stats.html.
   A mouse and focus extra only: every fact a tip carries is also visible text or in a table. The tip's HTML is
   built on the server from numbers and labels only (no ticket text). Also moves the flow chart's hairline. */
import { useEffect } from "react";

export function Tips() {
  useEffect(() => {
    const tip = document.getElementById("tip");
    if (!tip) return;
    let timer: ReturnType<typeof setTimeout> | undefined, cool: ReturnType<typeof setTimeout> | undefined;
    let warm = false;
    let owner: Element | null = null;

    const place = (target: Element, html: string, x0?: number) => {
      if (owner && owner !== target) owner.removeAttribute("aria-describedby");
      owner = target;
      target.setAttribute("aria-describedby", "tip");
      tip.innerHTML = html;
      tip.hidden = false;
      const parent = (tip.offsetParent as HTMLElement | null) ?? document.body;
      const pr = parent.getBoundingClientRect();
      const tr = target.getBoundingClientRect();
      let x = (x0 ?? tr.left + tr.width / 2) - pr.left + 14;
      let y = tr.top - pr.top - tip.offsetHeight - 10;
      if (tr.top - tip.offsetHeight - 10 < 8) y = tr.bottom - pr.top + 10;
      x = Math.max(8, Math.min(x, pr.width - tip.offsetWidth - 8));
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    };
    const show = (target: Element, x?: number) => {
      const html = (target as HTMLElement).dataset.tip ?? target.getAttribute("data-tip") ?? "";
      if (!html) return;
      clearTimeout(timer); clearTimeout(cool);
      if (warm) place(target, html, x);
      else timer = setTimeout(() => { warm = true; place(target, html, x); }, 150);
    };
    const hide = () => {
      clearTimeout(timer);
      tip.hidden = true;
      if (owner) { owner.removeAttribute("aria-describedby"); owner = null; }
      cool = setTimeout(() => { warm = false; }, 600);
    };
    const hair = (hit: Element | null, on: boolean) => {
      const hx = hit?.getAttribute("data-hx");
      const svg = hit?.closest("svg");
      const line = svg?.querySelector(".x-hair");
      if (!line || hx == null) return;
      line.setAttribute("x1", hx); line.setAttribute("x2", hx);
      line.setAttribute("visibility", on ? "visible" : "hidden");
    };
    const over = (e: PointerEvent) => {
      const t = (e.target as Element).closest?.("[data-tip]");
      if (t) { show(t, e.clientX); hair(t, true); }
    };
    const out = (e: PointerEvent) => {
      const t = (e.target as Element).closest?.("[data-tip]");
      if (t) { hide(); hair(t, false); }
    };
    const fin = (e: FocusEvent) => { const t = (e.target as Element).closest?.("[data-tip]"); if (t) show(t); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", fin);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", fin);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", key);
      hide();
    };
  }, []);
  return null;
}
