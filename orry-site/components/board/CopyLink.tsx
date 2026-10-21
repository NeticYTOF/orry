"use client";
/* "Copy site link" in the ticket's More menu. The link holds only the ticket number (PLAN 2.4 rule 1). */
import { toast } from "@/components/viz/live";

export function CopyLink({ id }: { id: number }) {
  return (
    <button
      className="btn sm"
      type="button"
      onClick={e => {
        const link = `${window.location.origin}/tickets/${id}`;
        void navigator.clipboard?.writeText(link).catch(() => undefined);
        toast(`Copied ${link}`);
        const ov = (e.currentTarget as HTMLElement).closest("details");
        if (ov) { ov.open = false; (ov.querySelector("summary") as HTMLElement | null)?.focus(); }
      }}
    >
      Copy site link
    </button>
  );
}
