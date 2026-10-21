"use client";
/* The phone drawer (under 820 px), from the mockup's app.js: focus moves into it, the rest goes inert,
   Escape and the scrim close it, and a link inside closes it. Also moves focus to #view after a page change. */
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export function ShellClient() {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    const $ = (id: string) => document.getElementById(id);
    const nav = $("nav"), scrim = $("scrim") as HTMLButtonElement | null, menuBtn = $("menuBtn"), close = $("drawerClose");
    const topbar = $("topbar"), main = $("mainCol");
    if (!nav || !scrim || !menuBtn || !close || !topbar || !main) return;
    const phone = window.matchMedia("(max-width: 820px)");

    const setDrawer = (open: boolean) => {
      nav.dataset.open = String(open);
      menuBtn.setAttribute("aria-expanded", String(open));
      scrim.hidden = !open;
      topbar.inert = open; main.inert = open; nav.inert = phone.matches && !open;
      if (open) close.focus(); else if (phone.matches) menuBtn.focus();
    };
    const onMenu = () => setDrawer(nav.dataset.open !== "true");
    const onClose = () => setDrawer(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && nav.dataset.open === "true") { e.preventDefault(); setDrawer(false); } };
    const onNavClick = (e: MouseEvent) => { if (phone.matches && (e.target as HTMLElement).closest("a")) setDrawer(false); };
    const onPhone = () => {
      if (!phone.matches) { nav.dataset.open = "false"; scrim.hidden = true; topbar.inert = false; main.inert = false; }
      nav.inert = phone.matches && nav.dataset.open !== "true";
    };
    menuBtn.addEventListener("click", onMenu);
    close.addEventListener("click", onClose);
    scrim.addEventListener("click", onClose);
    document.addEventListener("keydown", onKey);
    nav.addEventListener("click", onNavClick);
    phone.addEventListener("change", onPhone);
    nav.inert = phone.matches;
    return () => {
      menuBtn.removeEventListener("click", onMenu);
      close.removeEventListener("click", onClose);
      scrim.removeEventListener("click", onClose);
      document.removeEventListener("keydown", onKey);
      nav.removeEventListener("click", onNavClick);
      phone.removeEventListener("change", onPhone);
    };
  }, []);

  /* after a client-side page change, put focus at the top of the new page (the mockup's router did the same) */
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (window.location.hash) return;
    const v = document.getElementById("view");
    if (v) v.focus({ preventScroll: true });
  }, [pathname]);

  return null;
}
