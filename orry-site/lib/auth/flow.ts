/* Verified Hack Club identity enters only through an invited account, an approved request, or the configured owner bootstrap. */
import { now, tx } from "../db";
import { SLACK_ID_RE } from "./config";
import { logEvent } from "./events";
import type { Identity } from "./oidc";
import {
  accessRequestBySlack, accessRequestBySub, accountBySlack, accountBySub, claimInvite, createSession, deleteSessionByToken, insertAccessRequest, insertAccount, inviteById, shownState,
  type Account, type Invite
} from "./store";
import { getDb } from "../db";

export type Refusal =
  | "no_slack" | "bad_slack" | "no_account" | "off" | "sub_mismatch" | "request_pending" | "request_denied"
  | "invite_missing" | "invite_wrong_account" | "invite_expired" | "invite_used" | "invite_cancelled" | "invite_account_exists";

export type SignInOutcome =
  | { ok: true; token: string; account: Account }
  | { ok: false; code: Refusal; slackId?: string; invite?: Invite };

function refuse(code: Refusal, slackId: string | null, subject: string | null, reason: string, extra: { invite?: Invite } = {}): SignInOutcome {
  logEvent("sign_in_refused", slackId, { subject: subject ?? slackId ?? undefined, reason });
  return { ok: false, code, slackId: slackId ?? undefined, ...extra };
}

function checkSlack(identity: Identity): Refusal | null {
  if (!identity.slackId) return "no_slack";
  if (!SLACK_ID_RE.test(identity.slackId)) return "bad_slack";
  return null;
}

/** Trust on first use: a known hca_sub must keep its Slack ID, and an account's hca_sub never changes. */
function tofuProblem(identity: Identity, acct: Account | null): string | null {
  const bySub = accountBySub(identity.sub);
  if (bySub && bySub.slackId !== identity.slackId) return "slack_id_changed";
  const request = accessRequestBySub(identity.sub);
  if (request && request.slackId !== identity.slackId) return "slack_id_changed";
  if (acct && acct.hcaSub && acct.hcaSub !== identity.sub) return "hca_account_changed";
  return null;
}

export async function completeSignIn(identity: Identity, o: { inviteId?: number | null; oldToken?: string | null } = {}): Promise<SignInOutcome> {
  const bad = checkSlack(identity);
  if (bad) return refuse(bad, null, null, bad === "no_slack" ? "no_slack_link" : "bad_slack_id");
  const slackId = identity.slackId!;
  if (slackId === process.env.ORRY_SITE_OTP_SLACK_ID && !o.inviteId) return signInOwner(identity, slackId, o.oldToken ?? null);
  return o.inviteId ? acceptInvite(identity, slackId, o.inviteId, o.oldToken ?? null) : signInExisting(identity, slackId, o.oldToken ?? null);
}

function signInOwner(identity: Identity, slackId: string, oldToken: string | null): SignInOutcome {
  const acct = accountBySlack(slackId);
  const subjectOwner = accountBySub(identity.sub);
  const requestOwner = accessRequestBySub(identity.sub);
  if ((subjectOwner && subjectOwner.slackId !== slackId) || (requestOwner && requestOwner.slackId !== slackId)) return refuse("sub_mismatch", slackId, slackId, "slack_id_changed");
  const tofu = acct?.hcaSub?.startsWith("otp:") ? null : tofuProblem(identity, acct);
  if (tofu) return refuse("sub_mismatch", slackId, slackId, tofu);
  return tx(() => {
    const t = now();
    let id: number;
    if (acct) {
      getDb().prepare("UPDATE accounts SET hca_sub = ?, role = 'organizer', status = 'on', last_sign_in_at = ? WHERE id = ?").run(identity.sub, t, acct.id);
      id = acct.id;
    } else {
      id = insertAccount({ slackId, hcaSub: identity.sub, role: "organizer", createdBy: "bootstrap", createdAt: t, lastSignInAt: t });
    }
    if (oldToken) deleteSessionByToken(oldToken);
    const token = createSession(id);
    logEvent("bootstrap", null, { subject: slackId });
    logEvent("sign_in", slackId, { subject: slackId });
    return { ok: true, token, account: accountBySlack(slackId)! };
  });
}

async function signInExisting(identity: Identity, slackId: string, oldToken: string | null): Promise<SignInOutcome> {
  const acct = accountBySlack(slackId);
  const tofu = tofuProblem(identity, acct);
  if (tofu) return refuse("sub_mismatch", slackId, slackId, tofu);
  if (!acct) {
    const request = tx(() => {
      let current = accessRequestBySlack(slackId);
      if (!current) {
        if (accountBySub(identity.sub) || accessRequestBySub(identity.sub)) return null;
        const id = insertAccessRequest(slackId, identity.sub);
        logEvent("access_requested", null, { subject: slackId, reason: String(id) });
        current = accessRequestBySlack(slackId);
      }
      return current;
    });
    if (!request) return refuse("sub_mismatch", slackId, slackId, "subject_already_bound");
    if (request?.hcaSub && request.hcaSub !== identity.sub) return refuse("sub_mismatch", slackId, slackId, "request_identity_changed");
    if (request?.status === "denied") return refuse("request_denied", slackId, slackId, "request_denied");
    return refuse("request_pending", slackId, slackId, "access_request_pending");
  }
  /* made by bootstrap and never used: only its single-use link can finish it */
  if (!acct.hcaSub) return refuse("no_account", slackId, slackId, "needs_invite_link");
  if (acct.status !== "on") return refuse("off", slackId, slackId, "account_off");

  const token = tx(() => {
    if (oldToken) deleteSessionByToken(oldToken); /* rotate at sign-in */
    getDb().prepare("UPDATE accounts SET last_sign_in_at = ? WHERE id = ?").run(now(), acct.id);
    const t = createSession(acct.id);
    logEvent("sign_in", slackId, { subject: slackId });
    return t;
  });
  return { ok: true, token, account: acct };
}

const inviteRefusal = (inv: Invite): Refusal | null => {
  const s = shownState(inv);
  return s === "used" ? "invite_used" : s === "cancelled" ? "invite_cancelled" : s === "expired" ? "invite_expired" : null;
};

async function acceptInvite(identity: Identity, slackId: string, inviteId: number, oldToken: string | null): Promise<SignInOutcome> {
  const inv = inviteById(inviteId);
  if (!inv) return refuse("invite_missing", slackId, null, "invite_missing");
  const st = inviteRefusal(inv);
  if (st) return refuse(st, slackId, inv.slackId, st, { invite: inv });

  /* The one rule: the invite is for one Slack ID, not for whoever holds the link. The invite stays pending. */
  if (slackId !== inv.slackId) return refuse("invite_wrong_account", slackId, inv.slackId, "wrong_account", { invite: inv });

  const existing = accountBySlack(slackId);
  const tofu = tofuProblem(identity, existing);
  if (tofu) return refuse("sub_mismatch", slackId, slackId, tofu, { invite: inv });
  if (existing && existing.hcaSub) return refuse("invite_account_exists", slackId, slackId, "account_exists", { invite: inv });

  /* One transaction: consume the explicit organizer approval, make the account, make the session. */
  let result: SignInOutcome;
  try {
    result = tx(() => {
      if (!claimInvite(inv.id)) {
        const again = inviteById(inv.id)!;
        throw new InviteGone(inviteRefusal(again) ?? "invite_used");
      }
      const t = now();
      let accountId: number;
      if (existing) {
        getDb().prepare("UPDATE accounts SET hca_sub = ?, role = ?, status = 'on', last_sign_in_at = ? WHERE id = ?").run(identity.sub, inv.role, t, existing.id);
        accountId = existing.id;
      } else {
        accountId = insertAccount({ slackId, hcaSub: identity.sub, role: inv.role, createdBy: inv.createdBy, createdAt: t, lastSignInAt: t });
      }
      getDb().prepare("UPDATE access_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE slack_id = ? AND hca_sub = ? AND status = 'pending'").run(t, inv.createdBy, slackId, identity.sub);
      logEvent("invite_used", slackId, { subject: slackId, reason: inv.role });
      const account = accountBySlack(slackId)!;
      if (oldToken) deleteSessionByToken(oldToken);
      const token = createSession(accountId);
      logEvent("sign_in", slackId, { subject: slackId });
      return { ok: true, token, account } as SignInOutcome;
    });
  } catch (e) {
    if (e instanceof InviteGone) return refuse(e.code, slackId, inv.slackId, e.code, { invite: inv });
    throw e;
  }
  return result;
}

class InviteGone extends Error {
  constructor(public code: Refusal) { super(code); }
}
