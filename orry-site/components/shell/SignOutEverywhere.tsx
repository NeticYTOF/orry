/* "Sign out everywhere", for Settings and the Profile panel on My week. The button opens a small confirmation; the form in it
   is a plain POST, so it ends every session of the signed-in person and lands on the sign-in page. Styled by app/ui/admin.css (.ad-out). */
import { Modal } from "@/components/ui/Modal";

export function SignOutEverywhere() {
  return (
    <div className="ad-out">
      <h3 id="t-signout-all">Sign out everywhere</h3>
      <Modal label="Sign out everywhere" title="Sign out everywhere?" triggerClass="btn">
        <p className="ad-confirm">This ends your sessions on every device, this one too.</p>
        <form method="post" action="/api/auth/sign-out-all" className="inline-form ad-confirm-form">
          <button className="btn pri" type="submit" aria-describedby="t-signout-all">Sign out everywhere</button>
        </form>
      </Modal>
    </div>
  );
}
