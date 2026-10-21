"use client";
/* The mockup's theme switch (moon and sun in pixels). aria-pressed = light theme on. */
import { setPreference } from "./preferences";

export function ThemeToggle({ light }: { light: boolean }) {
  return (
    <button
      className="tg"
      type="button"
      data-theme-toggle=""
      aria-pressed={light}
      aria-label="Light theme"
      onClick={() => {
        const nowLight = document.body.dataset.displayTheme !== "light";
        void setPreference({ theme: nowLight ? "light" : "dark" });
      }}
    >
      <span className="pxw mo" aria-hidden="true"><i className="b" /></span>
      <span className="pxw su" aria-hidden="true"><i className="a" /></span>
    </button>
  );
}
