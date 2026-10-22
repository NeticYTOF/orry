"use client";
/* The shell's shared regions (#toast, #announce, #live). The elements live in components/shell/AppShell.tsx. */

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A short visible message (role=status), hidden again after 2.6 s. */
export function toast(msg: string): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/** The polite live region for count changes and reveals. */
export function announce(msg: string): void {
  const el = document.getElementById("announce");
  if (el) el.textContent = msg;
}

/** The status region the insights pages use ("Showing names.", "You are hidden from the leaderboard."). */
export function live(msg: string): void {
  const el = document.getElementById("live");
  if (el) el.textContent = msg;
}
