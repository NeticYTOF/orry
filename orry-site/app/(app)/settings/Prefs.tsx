"use client";
/* The three display choices as segmented controls. Each button calls setPreference(): the page changes at once and the
   choice is saved as a cookie. The controls also follow changes made elsewhere (the sidebar's theme switch), through
   the "orry:preferences" event that applyPreference() sends. */
import { useEffect, useState } from "react";
import { setPreference, type Prefs } from "@/components/shell/preferences";
import { live } from "@/components/viz/live";

type Initial = { theme: "dark" | "light"; people: "name" | "handle"; density: "standard" | "roomy" };

type Row<K extends keyof Prefs> = {
  key: K; id: string; title: string;
  options: Array<{ value: NonNullable<Prefs[K]>; label: string; said: string }>;
};

const ROWS: [Row<"theme">, Row<"people">, Row<"density">] = [
  {
    key: "theme", id: "pf-theme", title: "Theme",
    options: [{ value: "dark", label: "Dark", said: "Dark theme." }, { value: "light", label: "Light", said: "Light theme." }]
  },
  {
    key: "people", id: "pf-people", title: "Show people as",
    options: [{ value: "name", label: "Names", said: "Showing names." }, { value: "handle", label: "@usernames", said: "Showing usernames." }]
  },
  {
    key: "density", id: "pf-density", title: "Density",
    options: [{ value: "standard", label: "Standard", said: "Standard density." }, { value: "roomy", label: "Roomy", said: "Roomy density." }]
  }
];

export function DisplayPrefs({ initial }: { initial: Initial }) {
  const [now, setNow] = useState<Initial>(initial);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<Prefs>).detail;
      if (d) setNow(prev => ({ ...prev, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v)) }));
    };
    window.addEventListener("orry:preferences", on);
    return () => window.removeEventListener("orry:preferences", on);
  }, []);

  async function choose(p: Prefs, said: string) {
    const ok = await setPreference(p);
    live(ok ? said : said + " It could not be saved, so it lasts until you reload.");
  }

  return (
    <div className="ad-prefs">
      {ROWS.map(r => (
        <div className="ad-pref" key={r.key}>
          <h3 id={r.id}>{r.title}</h3>
          <div className="tabs" role="group" aria-labelledby={r.id}>
            {r.options.map(o => (
              <button key={o.value} type="button" aria-pressed={now[r.key] === o.value}
                onClick={() => { void choose({ [r.key]: o.value } as Prefs, o.said); }}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
