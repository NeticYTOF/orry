/* The "Needs a human" count beside Board in the sidebar (#navBoardCount, in the shell), for pages other than the
   board (the board sets it itself). Streams in after the page; a failure leaves the count empty. */
import { Suspense } from "react";
import { getBoardModel } from "@/lib/models";
import type { Session } from "@/lib/session";
import { NavCountEffect } from "./NavCountEffect";

async function Count({ session }: { session: Session }) {
  const m = await getBoardModel(session, {}).catch(() => null);
  const n = m && !m.error && m.freshness.state !== "not_connected" ? m.headline.needHuman : null;
  return <NavCountEffect n={n} />;
}

export function NavCount({ session }: { session: Session }) {
  return <Suspense fallback={null}><Count session={session} /></Suspense>;
}
