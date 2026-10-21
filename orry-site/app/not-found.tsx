/* Unknown address: LOADOUT's lamp page in small. One screen with nothing to scroll: a tag, the title, one line of copy and
   one way back, over a faint depth numeral and a lamp glow (app/ui/auth.css, .au-lost). Sent with a real 404 status. */
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="au-lost" id="view">
      <span className="au-depth" aria-hidden="true">404</span>
      <div className="au-lost-in">
        <p className="au-lost-tag">404 · off the map</p>
        <h1>Nothing down here</h1>
        <p className="au-lost-copy">This address is not part of the help desk. It may have moved, or the link is wrong.</p>
        <Link className="btn pri" href="/board">Back to the board</Link>
      </div>
    </main>
  );
}
