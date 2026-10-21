/* The in-shell note a helper sees on an organizer page (the mockup router's org-only view). Kit: PageHead + .state. */
import { PageHead } from "@/components/ui/PageHead";

export function OrganizersOnly({ title }: { title: string }) {
  return (
    <>
      <PageHead kicker="Organizers" title={title} />
      <section className="state or-os" aria-labelledby="oo-h">
        <div className="mole away" aria-hidden="true" />
        <div>
          <h2 id="oo-h">This page is for organizers.</h2>
          <p>You are signed in as a helper. Ask an organizer if you need something changed.</p>
          <div className="blk btn-row"><a className="btn pri" href="/board">Back to the board</a></div>
        </div>
      </section>
    </>
  );
}
