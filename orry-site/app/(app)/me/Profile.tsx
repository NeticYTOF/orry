"use client";
/* The two switches in the Profile panel (mockups/me.html): Show me on the leaderboard (saved on the server) and
   Show people as (the shell's display preference, a cookie, applied at once with no re-render). */
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { setPreference } from "@/components/shell/preferences";
import { live } from "@/components/viz/live";
import { saveShowOnLeaderboard } from "./actions";

export function LeaderboardSwitch({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, start] = useTransition();
  return (
    <button className="btn tog" type="button" id="togLead" aria-pressed={on} aria-labelledby="t-lead" aria-busy={busy || undefined}
      onClick={() => {
        const next = !on;
        setOn(next);
        start(async () => {
          const r = await saveShowOnLeaderboard(next).catch(() => ({ ok: false, show: !next }));
          if (!r.ok) { setOn(r.show); live("That did not save. Try again."); return; }
          live(next ? "You are shown on the leaderboard." : "You are hidden from the leaderboard.");
        });
      }}>
      <span id="togLeadTxt">{on ? "On" : "Off"}</span>
    </button>
  );
}

export function PeopleSwitch({ initial }: { initial: "name" | "handle" }) {
  return (
    <div className="tabs" role="group" aria-labelledby="t-names" id="peopleChips">
      {(["name", "handle"] as const).map(v => (
        <button key={v} type="button" data-people-btn={v} aria-pressed={initial === v}
          onClick={() => { void setPreference({ people: v }); live(v === "name" ? "Showing names." : "Showing usernames."); }}>
          {v === "name" ? "Names" : "@usernames"}
        </button>
      ))}
    </div>
  );
}

/** Links and bookmarks to /me#profile land on the Profile tab: the server cannot see the hash, so this hops to ?tab=profile. */
export function ProfileHashRedirect() {
  const router = useRouter();
  useEffect(() => {
    if (window.location.hash === "#profile") router.replace("/me?tab=profile", { scroll: false });
  }, [router]);
  return null;
}
