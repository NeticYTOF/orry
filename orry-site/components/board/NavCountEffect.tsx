"use client";
import { useEffect } from "react";

/** Writes the count into the shell's #navBoardCount. */
export function NavCountEffect({ n }: { n: number | null }) {
  useEffect(() => {
    const el = document.getElementById("navBoardCount");
    if (el) el.textContent = n == null ? "" : String(n);
  }, [n]);
  return null;
}
