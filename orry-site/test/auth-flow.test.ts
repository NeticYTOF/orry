/* Invites, sign-in, sessions and the guard rails (PLAN 7.2, 7.3, 7.6; decisions L23-L25). */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/data", async () => {
  const h = await import("./auth-stub");
  return { getDataSource: () => h.stub };
});

import { account, advance, count, fresh, identity, roster, sub } from "./auth-helpers";
import { completeSignIn } from "../lib/auth/flow";
import { checkSession } from "../lib/auth/guard";
import { accountBySlack, createSession, insertInvite, inviteById, inviteByToken } from "../lib/auth/store";
import { bootstrapOrganizer, cancelInvite, createInvite, resendInvite, setRole, setStatus, signOutEverywhere, TeamError } from "../lib/auth/team";
import { sha256 } from "../lib/auth/crypto";
import { getDb } from "../lib/db";
import { IDLE_MS, ABSOLUTE_MS } from "../lib/auth/config";

const PAT = "U0PAT0001", JUNO = "U0JUNO001", SAM = "U0SAM0001", QUINN = "U0QUIN001", OTHER = "U0OTHER01", ZARA = "U0ZARA001";
const pat = { slackId: PAT, role: "organizer" as const };

beforeEach(() => { fresh(); account(PAT, "organizer"); });

function invite(slackId: string, days = 7, role: "helper" | "organizer" = "helper") {
  return insertInvite({ slackId, role, createdBy: PAT, days });
}

describe("invite acceptance", () => {
  it("the right account: uses the invite, makes the account and a session, in one go", async () => {
    const { id } = invite(SAM);
    const out = await completeSignIn(identity(SAM), { inviteId: id });
    expect(out.ok).toBe(true);
    expect(inviteById(id)!.state).toBe("used");
    const a = accountBySlack(SAM)!;
    expect(a).toMatchObject({ role: "helper", status: "on", hcaSub: sub(SAM) });
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?", a.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM access_events WHERE kind = 'invite_used' AND subject_slack_id = ?", SAM)).toBe(1);
    if (out.ok) expect((await checkSession(out.token)).ok).toBe(true);
  });

  it("a wrong account does not burn the invite, and the refusal is logged", async () => {
    const { id } = invite(SAM);
    const out = await completeSignIn(identity(OTHER), { inviteId: id });
    expect(out).toMatchObject({ ok: false, code: "invite_wrong_account", slackId: OTHER });
    expect(inviteById(id)!.state).toBe("pending");
    expect(accountBySlack(OTHER)).toBeNull();
    expect(accountBySlack(SAM)).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM access_events WHERE kind = 'sign_in_refused' AND reason = 'wrong_account' AND actor_slack_id = ? AND subject_slack_id = ?", OTHER, SAM)).toBe(1);
    /* and the right person can still use it afterwards */
    expect((await completeSignIn(identity(SAM), { inviteId: id })).ok).toBe(true);
  });

  it("double use makes one account (two at once, then a third later)", async () => {
    const { id } = invite(SAM);
    const [a, b] = await Promise.all([completeSignIn(identity(SAM), { inviteId: id }), completeSignIn(identity(SAM), { inviteId: id })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({ ok: false });
    expect(["invite_used", "invite_account_exists"]).toContain((loser as { code: string }).code);
    const c = await completeSignIn(identity(SAM), { inviteId: id });
    expect(c).toMatchObject({ ok: false, code: "invite_used" });
    expect(count("SELECT COUNT(*) AS n FROM accounts WHERE slack_id = ?", SAM)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(1);
  });

  it("an invite that expires between page load and Continue is refused", async () => {
    const { id } = invite(SAM, 1);
    advance(86_400_000 - 1000); /* page loads with a second to go */
    expect(inviteById(id)!.state).toBe("pending");
    advance(2000); /* Continue, then the callback */
    const out = await completeSignIn(identity(SAM), { inviteId: id });
    expect(out).toMatchObject({ ok: false, code: "invite_expired" });
    expect(accountBySlack(SAM)).toBeNull();
  });

  it("cancelled and unknown invites are refused", async () => {
    const { id } = invite(SAM);
    cancelInvite(pat, id);
    expect(await completeSignIn(identity(SAM), { inviteId: id })).toMatchObject({ ok: false, code: "invite_cancelled" });
    expect(await completeSignIn(identity(SAM), { inviteId: 999 })).toMatchObject({ ok: false, code: "invite_missing" });
  });

  it("the token is stored only as a hash", () => {
    const { id, token } = invite(SAM);
    const row = getDb().prepare("SELECT * FROM invites WHERE id = ?").get(id) as Record<string, unknown>;
    expect(Object.values(row)).not.toContain(token);
    expect(row.token_hash).toBe(sha256(token));
    expect(inviteByToken(token)!.id).toBe(id);
  });
});

describe("both locks: an invite-made account AND Orry's roster (L23)", () => {
  it("invite valid but not on the roster: account is made, no session", async () => {
    const { id } = invite(QUINN);
    const out = await completeSignIn(identity(QUINN), { inviteId: id });
    expect(out).toMatchObject({ ok: false, code: "roster" });
    expect(accountBySlack(QUINN)).not.toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
    /* signing in later is still refused while they are off the roster */
    expect(await completeSignIn(identity(QUINN))).toMatchObject({ ok: false, code: "roster" });
    roster.helper.add(QUINN);
    expect((await completeSignIn(identity(QUINN))).ok).toBe(true);
  });

  it("on the roster but no account: refused", async () => {
    expect(await completeSignIn(identity(JUNO))).toMatchObject({ ok: false, code: "no_account" });
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
  });

  it("Orry cannot be asked: fail closed, the invite stays pending", async () => {
    const { id } = invite(SAM);
    roster.down = true;
    expect(await completeSignIn(identity(SAM), { inviteId: id })).toMatchObject({ ok: false, code: "offline" });
    expect(inviteById(id)!.state).toBe("pending");
    account(JUNO);
    expect(await completeSignIn(identity(JUNO))).toMatchObject({ ok: false, code: "offline" });
  });

  it("a person removed from the roster loses access within 5 minutes", async () => {
    account(JUNO);
    const out = await completeSignIn(identity(JUNO));
    if (!out.ok) throw new Error("sign-in failed");
    roster.helper.delete(JUNO);
    advance(4 * 60_000);
    expect((await checkSession(out.token)).ok).toBe(true); /* still inside the 5-minute window */
    advance(60_000);
    expect(await checkSession(out.token)).toMatchObject({ ok: false, reason: "roster" });
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
  });

  it("a cached role lasts up to 15 minutes when Orry cannot be asked, then access pauses", async () => {
    account(JUNO);
    const out = await completeSignIn(identity(JUNO));
    if (!out.ok) throw new Error("sign-in failed");
    roster.down = true;
    advance(6 * 60_000);
    expect(await checkSession(out.token)).toMatchObject({ ok: true, roleStale: true });
    advance(10 * 60_000);
    expect(await checkSession(out.token)).toMatchObject({ ok: false, reason: "offline" });
    roster.down = false;
    expect((await checkSession(out.token)).ok).toBe(true); /* back once Orry answers */
  });
});

describe("sign-in checks", () => {
  it("needs a Slack ID in the right shape", async () => {
    account(JUNO);
    expect(await completeSignIn(identity(null))).toMatchObject({ ok: false, code: "no_slack" });
    expect(await completeSignIn(identity("u0juno001", sub(JUNO)))).toMatchObject({ ok: false, code: "bad_slack" });
    expect(await completeSignIn(identity("X0JUNO001"))).toMatchObject({ ok: false, code: "bad_slack" });
  });

  it("trust on first use: a changed Hack Club account for a Slack ID is refused", async () => {
    account(JUNO);
    expect(await completeSignIn(identity(JUNO, "someone-else"))).toMatchObject({ ok: false, code: "sub_mismatch" });
    /* and a known hca_sub claiming another Slack ID */
    expect(await completeSignIn(identity(PAT, sub(JUNO)))).toMatchObject({ ok: false, code: "sub_mismatch" });
  });

  it("a turned-off account cannot sign in", async () => {
    account(ZARA, "helper", "off");
    expect(await completeSignIn(identity(ZARA))).toMatchObject({ ok: false, code: "off" });
  });

  it("sessions rotate at sign-in: the old session ID stops working", async () => {
    account(JUNO);
    const a = await completeSignIn(identity(JUNO));
    if (!a.ok) throw new Error("sign-in failed");
    const b = await completeSignIn(identity(JUNO), { oldToken: a.token });
    if (!b.ok) throw new Error("sign-in failed");
    expect(b.token).not.toBe(a.token);
    expect((await checkSession(a.token)).ok).toBe(false);
    expect((await checkSession(b.token)).ok).toBe(true);
  });
});

describe("sessions", () => {
  it("store only the hash of the session ID", async () => {
    account(JUNO);
    const out = await completeSignIn(identity(JUNO));
    if (!out.ok) throw new Error("sign-in failed");
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/); /* 32 random bytes */
    const rows = getDb().prepare("SELECT * FROM sessions").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(out.token);
    expect(rows[0].id_hash).toBe(sha256(out.token));
  });

  it("a turned-off account's open session dies at once", async () => {
    const id = account(JUNO);
    const out = await completeSignIn(identity(JUNO));
    if (!out.ok) throw new Error("sign-in failed");
    setStatus(pat, id, "off");
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?", id)).toBe(0);
    expect((await checkSession(out.token)).ok).toBe(false);
  });

  it("a turned-off account's session dies even if deleting the sessions failed", async () => {
    const id = account(JUNO);
    const out = await completeSignIn(identity(JUNO));
    if (!out.ok) throw new Error("sign-in failed");
    getDb().prepare("UPDATE accounts SET status = 'off' WHERE id = ?").run(id); /* sessions left behind */
    expect(await checkSession(out.token)).toMatchObject({ ok: false, reason: "off" });
  });

  it("idle 12 hours or 7 days old: ended", async () => {
    const id = account(JUNO);
    const t1 = createSession(id);
    advance(IDLE_MS + 1);
    expect(await checkSession(t1)).toMatchObject({ ok: false, reason: "ended" });
    const t2 = createSession(id);
    for (let i = 0; i < 15; i++) { advance(11 * 3_600_000); expect((await checkSession(t2)).ok).toBe(true); }
    advance(ABSOLUTE_MS);
    expect(await checkSession(t2)).toMatchObject({ ok: false, reason: "ended" });
  });

  it("a role change ends the person's sessions", async () => {
    const id = account(JUNO);
    const t = createSession(id);
    setRole(pat, id, "organizer");
    expect((await checkSession(t)).ok).toBe(false);
  });

  it("helpers are kept out of organizer routes", async () => {
    const id = account(JUNO);
    const t = createSession(id);
    expect(await checkSession(t, "organizer")).toMatchObject({ ok: false, reason: "forbidden" });
    expect((await checkSession(t, "helper")).ok).toBe(true);
  });

  it("sign out everywhere ends every session of that person only", async () => {
    const j = account(JUNO);
    const a = createSession(j), b = createSession(j);
    const p = createSession(accountBySlack(PAT)!.id);
    expect(signOutEverywhere(j, JUNO)).toBe(2);
    expect((await checkSession(a)).ok).toBe(false);
    expect((await checkSession(b)).ok).toBe(false);
    expect((await checkSession(p)).ok).toBe(true);
  });
});

describe("guard rails (L25)", () => {
  it("the last organizer cannot be turned off or made a helper", () => {
    const code = (fn: () => void) => { try { fn(); return "none"; } catch (e) { return (e as TeamError).code; } };
    const leila = { slackId: "U0LEILA01", role: "organizer" as const };
    const patId = accountBySlack(PAT)!.id;
    expect(code(() => setStatus(leila, patId, "off"))).toBe("last_organizer");
    expect(code(() => setRole(leila, patId, "helper"))).toBe("last_organizer");
    expect(accountBySlack(PAT)).toMatchObject({ role: "organizer", status: "on" });
    /* with a second organizer it is allowed, and then the second one is the last */
    const leilaId = account("U0LEILA01", "organizer");
    expect(code(() => setRole(leila, patId, "helper"))).toBe("none");
    const ravi = { slackId: "U0RAVI001", role: "organizer" as const };
    expect(code(() => setStatus(ravi, leilaId, "off"))).toBe("last_organizer");
    expect(code(() => setRole(ravi, leilaId, "helper"))).toBe("last_organizer");
    /* a turned-off organizer does not count */
    const third = account("U0MIA0001", "organizer", "off");
    expect(code(() => setStatus(ravi, leilaId, "off"))).toBe("last_organizer");
    void third;
  });

  it("nobody changes their own role or turns themselves off", () => {
    account("U0LEILA01", "organizer");
    const me = accountBySlack(PAT)!.id;
    expect(() => setRole(pat, me, "helper")).toThrow(/own role/);
    expect(() => setStatus(pat, me, "off")).toThrow(/own account/);
  });

  it("helpers cannot use team actions", async () => {
    await expect(createInvite({ slackId: JUNO, role: "helper" }, { user: "sand-finch", role: "helper", days: 7 })).rejects.toThrow(/organizers/);
  });

  it("at most 20 open invites, and 30 a day per organizer", async () => {
    for (let i = 0; i < 20; i++) insertInvite({ slackId: "U0TEST" + String(i).padStart(4, "0"), role: "helper", createdBy: "U0LEILA01", days: 7 });
    await expect(createInvite(pat, { user: "sand-finch", role: "helper", days: 7 })).rejects.toMatchObject({ code: "too_many_open" });
    getDb().prepare("UPDATE invites SET state = 'cancelled'").run();
    for (let i = 0; i < 30; i++) insertInvite({ slackId: "U0DAY" + String(i).padStart(5, "0"), role: "helper", createdBy: PAT, days: 7 });
    getDb().prepare("UPDATE invites SET state = 'cancelled'").run();
    await expect(createInvite(pat, { user: "sand-finch", role: "helper", days: 7 })).rejects.toMatchObject({ code: "daily_limit" });
    advance(86_400_000 + 1);
    await expect(createInvite(pat, { user: "sand-finch", role: "helper", days: 7 })).resolves.toMatchObject({ handle: "sand-finch" });
  });

  it("create warns when the person is not on Orry's roster; refuses people who have an account or an open invite", async () => {
    const q = await createInvite(pat, { user: "@quartz-hare", role: "helper", days: 7 });
    expect(q.warning).toMatch(/not on Orry's helper list/);
    await expect(createInvite(pat, { user: "quartz-hare", role: "helper", days: 7 })).rejects.toMatchObject({ code: "has_invite" });
    account(JUNO);
    await expect(createInvite(pat, { user: "pixel-otter", role: "helper", days: 7 })).rejects.toMatchObject({ code: "has_account" });
    await expect(createInvite(pat, { user: "nobody-here", role: "helper", days: 7 })).rejects.toMatchObject({ code: "unknown_user" });
    await expect(createInvite(pat, { user: "sand-finch", role: "helper", days: 3 })).rejects.toMatchObject({ code: "bad_days" });
  });

  it("send again cancels the old link and makes a new one", async () => {
    const first = await createInvite(pat, { user: "sand-finch", role: "helper", days: 7 });
    const again = await resendInvite(pat, first.id);
    expect(inviteById(first.id)!.state).toBe("cancelled");
    expect(inviteById(again.id)!.state).toBe("pending");
    expect(await completeSignIn(identity(SAM), { inviteId: first.id })).toMatchObject({ ok: false, code: "invite_cancelled" });
    expect((await completeSignIn(identity(SAM), { inviteId: again.id })).ok).toBe(true);
  });

  it("every change is an access event", async () => {
    const inv = await createInvite(pat, { user: "sand-finch", role: "helper", days: 7 });
    cancelInvite(pat, inv.id);
    const j = account(JUNO);
    setRole(pat, j, "organizer");
    setStatus(pat, j, "off");
    setStatus(pat, j, "on");
    const kinds = (getDb().prepare("SELECT kind FROM access_events ORDER BY id").all() as Array<{ kind: string }>).map(r => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["invite_created", "invite_cancelled", "role_changed", "account_off", "account_on"]));
  });
});

describe("bootstrap", () => {
  it("refuses when an organizer exists", () => {
    expect(() => bootstrapOrganizer("U0NEWORG01")).toThrow(/already exists/);
  });

  it("makes the first organizer and a single-use link that binds the Hack Club account", async () => {
    fresh(); /* empty database */
    const { token } = bootstrapOrganizer(PAT);
    expect(() => bootstrapOrganizer("U0SECOND01")).toThrow(/already exists/);
    /* plain sign-in cannot finish it: only the link can */
    expect(await completeSignIn(identity(PAT))).toMatchObject({ ok: false, code: "no_account" });
    const inv = inviteByToken(token)!;
    expect(inv).toMatchObject({ role: "organizer", state: "pending" });
    const out = await completeSignIn(identity(PAT), { inviteId: inv.id });
    expect(out.ok).toBe(true);
    expect(accountBySlack(PAT)).toMatchObject({ role: "organizer", hcaSub: sub(PAT) });
    expect(await completeSignIn(identity(PAT), { inviteId: inv.id })).toMatchObject({ ok: false, code: "invite_used" });
  });

  it("rejects a malformed Slack ID", () => {
    fresh();
    expect(() => bootstrapOrganizer("not-an-id")).toThrow(/Slack user ID/);
  });
});
