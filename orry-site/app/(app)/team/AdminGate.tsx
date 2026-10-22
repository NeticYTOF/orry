/* What a helper sees on an organizer page: the same words as before, in the kit's calm empty state. Server-safe. */
import { PageHead } from "@/components/ui/PageHead";

export function AdminGate({ title }: { title: string }) {
  return (
    <div id="top" className="ad-page" tabIndex={-1}>
      <PageHead kicker="Organizers" title={title} />
      <div className="state plain ad-gate">
        <span className="mole away" aria-hidden="true" />
        <div>
          <h2>This page is for organizers.</h2>
          <p>You are signed in as a helper. Ask an organizer if you need something changed.</p>
          <a className="btn pri blk" href="/board">Back to the board</a>
        </div>
      </div>
    </div>
  );
}
