"use client";
/* Display preferences in the browser. The attribute changes at once on <html> and <body>; the cookie is set by
   POST /api/me/preferences so the next page load paints right on the server. */

export type Prefs = { theme?: "dark" | "light"; people?: "name" | "handle"; density?: "standard" | "roomy" };
const ATTR = { theme: "displayTheme", people: "people", density: "density" } as const;

export function applyPreference(p: Prefs): void {
  for (const k of Object.keys(p) as Array<keyof Prefs>) {
    const v = p[k];
    if (!v) continue;
    document.documentElement.dataset[ATTR[k]] = v;
    document.body.dataset[ATTR[k]] = v;
  }
  if (p.theme) document.querySelectorAll("[data-theme-toggle]").forEach(b => b.setAttribute("aria-pressed", String(p.theme === "light")));
  if (p.people) document.querySelectorAll("[data-people-btn]").forEach(b => b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.peopleBtn === p.people)));
  window.dispatchEvent(new CustomEvent("orry:preferences", { detail: p }));
}

/** Changes the page now and saves the choice. Resolves false if saving failed (the page keeps the change). */
export async function setPreference(p: Prefs): Promise<boolean> {
  applyPreference(p);
  try {
    const r = await fetch("/api/me/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
      credentials: "same-origin"
    });
    return r.ok;
  } catch {
    return false;
  }
}
