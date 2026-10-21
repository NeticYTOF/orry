"use client";
/* "Chart | Table" for a server-rendered chart: a two-button segment in the kit's .tabs. The chart and its table are
   both in the page; this flips data-view on the .vz-box (CSS hides the other one). Phones start on the table
   (PLAN 4.3 Phone). */
import { useEffect, useState } from "react";

export function VizToggle({ target }: { target: string }) {
  const [view, setView] = useState<"chart" | "table">("chart");

  useEffect(() => {
    const main = document.getElementById("mainCol");
    if (main && main.clientWidth < 600) setView("table");
  }, []);
  useEffect(() => {
    const box = document.getElementById(target);
    if (box) box.dataset.view = view;
  }, [target, view]);

  return (
    <div className="tabs vz-seg" role="group" aria-label="Show as">
      <button type="button" aria-controls={target} aria-pressed={view === "chart"} onClick={() => setView("chart")}>Chart</button>
      <button type="button" aria-controls={target} aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button>
    </div>
  );
}
