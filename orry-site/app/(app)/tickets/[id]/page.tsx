/* /tickets/[id]: the ticket as a full page (PLAN 4.2). The same TicketView as the board's pane, in a framed panel
   (two columns when wide, sticky footer: app/ui/ticket.css). Not found, another program, or (for helpers) outside the
   program's channels: the 404 page, and the title never echoes the number. */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NavCount } from "@/components/board/NavCount";
import { TicketView } from "@/components/board/TicketView";
import { getTicketModel } from "@/lib/models";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Ticket" };
export const dynamic = "force-dynamic";

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession("helper");
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) notFound();
  const t = await getTicketModel(s, Number(id));
  if (!t) notFound();
  return (
    <div className="tk-pagewrap">
      <p className="tk-back"><a className="lnk" href="/board"><span aria-hidden="true">← </span>Back to board</a></p>
      <article className="panel tk-page" aria-labelledby="shTitle">
        <TicketView t={t} mode="page" />
      </article>
      <NavCount session={s} />
    </div>
  );
}
