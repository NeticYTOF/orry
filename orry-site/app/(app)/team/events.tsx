/* Access events as plain sentences (the mockup's "Recent access events"). People are shown in both forms. */
import type { ReactNode } from "react";
import { PersonText, type WhoPerson } from "@/components/shell/Who";
import type { AccessEvent } from "@/lib/auth/events";

export function eventSentence(e: AccessEvent, people: Map<string, WhoPerson>): ReactNode {
  const P = (id: string | null): ReactNode => {
    if (!id) return <b>someone</b>;
    const p = people.get(id);
    return p ? <PersonText p={p} bold /> : <b>{id}</b>;
  };
  const a = P(e.actorSlackId), s = P(e.subjectSlackId), r = e.reason ?? "";
  switch (e.kind) {
    case "invite_created": return <>{a} created an invite for {s} ({r || "helper"}).</>;
    case "invite_cancelled": return <>{a} cancelled the invite for {s}.</>;
    case "invite_used": return <>{s} used an invite and joined as {r === "organizer" ? "an organizer" : "a helper"}.</>;
    case "sign_in": return <>{a} signed in.</>;
    case "sign_out": return <>{a} signed out.</>;
    case "account_off": return <>{a} turned off {s}.</>;
    case "account_on": return <>{a} turned on {s}.</>;
    case "role_changed": return <>{a} made {s} {r.endsWith("organizer") ? "an organizer" : "a helper"}.</>;
    case "bootstrap": return <>The first organizer account was made for {s} on the server.</>;
    case "sessions_revoked":
      if (r === "sign_out_everywhere") return <>{s} signed out everywhere.</>;
      if (r.startsWith("not_on_roster")) return <>{s} was signed out: no longer on Orry&apos;s helper list.</>;
      return <>{s} was signed out everywhere.</>;
    case "sign_in_refused":
      switch (r) {
        case "no_account": return <>A sign-in was refused: the Slack account <b>{e.subjectSlackId}</b> has no account here.</>;
        case "wrong_account": return <>A sign-in was refused: {a} tried to use the invite for {s}.</>;
        case "account_off": return <>A sign-in was refused: {s} is turned off.</>;
        case "not_on_roster": return <>{s} was refused: not on Orry&apos;s helper list.</>;
        case "orry_offline": return <>A sign-in by {s} was refused because Orry could not be asked about the roster.</>;
        case "slack_id_changed": case "hca_account_changed": return <>A sign-in was refused: the Hack Club account for {s} changed. Check this with them.</>;
        case "needs_invite_link": return <>A sign-in was refused: {s} has to use their single-use link first.</>;
        case "no_slack_link": return <>A sign-in was refused: the Hack Club account has no linked Slack account.</>;
        case "invite_expired": return <>A sign-in was refused: the invite for {s} had expired.</>;
        case "invite_used": return <>A sign-in was refused: the invite for {s} was already used.</>;
        case "invite_cancelled": return <>A sign-in was refused: the invite for {s} was cancelled.</>;
        case "account_exists": return <>{s} opened an invite but already has an account.</>;
        default: return r.startsWith("oidc_") ? <>A sign-in failed: the answer from Hack Club did not check out.</> : <>A sign-in was refused.</>;
      }
    case "ticket_view": return <>{a} opened {r || "a ticket"}.</>;
    case "ticket_reveal": return <>{a} showed the question text of {r || "a ticket"}.</>;
    default: return <>{e.kind.replace(/_/g, " ")}.</>;
  }
}
