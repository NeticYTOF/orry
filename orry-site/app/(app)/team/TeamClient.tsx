"use client";
/* The Team page's actions. Every one is a real POST to /api/team/* (Origin-checked, organizer-only); the server
   applies the guard rails. A new invite link is shown once and kept only in this page's memory. */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Modal } from "@/components/ui/Modal";

/* ---------- a tiny store for links made in this page view (never saved) ---------- */
const links = new Map<number, string>();
const subs = new Set<() => void>();
const linkStore = {
  set(id: number, link: string) { links.set(id, link); subs.forEach(f => f()); },
  get(id: number) { return links.get(id) ?? null; },
  sub(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
};

function toast(msg: string) {
  const t = document.getElementById("toast");
  const live = document.getElementById("live");
  if (live) live.textContent = msg;
  if (!t) return;
  t.textContent = msg; t.hidden = false;
  window.setTimeout(() => { t.hidden = true; }, 2600);
}

async function post(url: string, body?: object): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const r = await fetch(url, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body ?? {})
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 401 && typeof data.redirect === "string") { window.location.href = data.redirect; }
    return { ok: r.ok, data };
  } catch {
    return { ok: false, data: { message: "The site could not be reached. Nothing was changed." } };
  }
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast("The link is copied."); }
  catch { toast("Copy did not work. Select the link and copy it by hand."); }
}

/* ---------- the Invite button and its modal ---------- */
export function InviteModal() {
  return <Modal label="Invite someone" title="Invite someone" triggerClass="btn pri"><InviteForm /></Modal>;
}

/* ---------- a small confirm modal for row actions: one short line, Cancel and the action ---------- */
const closeDialog = (e: MouseEvent<HTMLElement>) => e.currentTarget.closest("dialog")?.close();

function ConfirmModal({ label, who, title, line, confirm, keep = "Cancel", disabled, onConfirm }: {
  label: string; who?: string; title: string; line: string; confirm: string; keep?: string; disabled?: boolean; onConfirm: () => void;
}) {
  return (
    <Modal
      label={<>{label}{who ? <span className="vh">: {who}</span> : null}</>}
      title={title}
      triggerClass="txt-link"
      footer={
        <>
          <button type="button" className="btn" onClick={closeDialog}>{keep}</button>
          <button type="button" className="btn pri" disabled={disabled} onClick={e => { closeDialog(e); onConfirm(); }}>{confirm}</button>
        </>
      }
    >
      <p className="ad-confirm">{line}</p>
    </Modal>
  );
}

export function InviteForm() {
  const router = useRouter();
  const [user, setUser] = useState("");
  const [role, setRole] = useState("helper");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ link: string; warning: string | null; handle: string } | null>(null);
  const [opts, setOpts] = useState<Array<{ handle: string; name: string }>>([]);
  const timer = useRef<number | undefined>(undefined);
  const linkRef = useRef<HTMLElement>(null);

  useEffect(() => {
    window.clearTimeout(timer.current);
    const q = user.replace(/^@/, "").trim();
    if (!q) { setOpts([]); return; }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await fetch("/api/team/suggest?q=" + encodeURIComponent(q), { credentials: "same-origin" });
        const d = (await r.json()) as { people?: Array<{ handle: string; name: string }> };
        setOpts(d.people ?? []);
      } catch { setOpts([]); }
    }, 150);
    return () => window.clearTimeout(timer.current);
  }, [user]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const u = user.trim().replace(/^@/, "").toLowerCase();
    if (!u || busy) return;
    setBusy(true); setError(null);
    const { ok, data } = await post("/api/team/invites", { user: u, role, days: Number(days) });
    setBusy(false);
    if (!ok) { setError(String(data.message ?? "That did not work.")); return; }
    const inv = data.invite as { id: number; handle: string };
    linkStore.set(inv.id, String(data.link));
    setResult({ link: String(data.link), warning: (data.warning as string | null) ?? null, handle: inv.handle });
    setUser("");
    router.refresh();
    window.setTimeout(() => linkRef.current?.focus(), 0);
  }

  return (
    <>
      <form className="ad-invite" id="invForm" autoComplete="off" onSubmit={submit}>
        <div className="field">
          <label htmlFor="invUser">Slack username</label>
          <input id="invUser" list="slackUsers" placeholder="@username" required value={user} onChange={e => setUser(e.target.value)} />
        </div>
        <datalist id="slackUsers">
          {opts.map(o => <option key={o.handle} value={o.handle}>{o.name}</option>)}
        </datalist>
        <div className="field">
          <label htmlFor="invRole">Role</label>
          <select id="invRole" value={role} onChange={e => setRole(e.target.value)}><option value="helper">Helper</option><option value="organizer">Organizer</option></select>
        </div>
        <div className="field">
          <label htmlFor="invExp">Link works for</label>
          <select id="invExp" value={days} onChange={e => setDays(e.target.value)}><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select>
        </div>
        <button className="btn pri" type="submit" disabled={busy}>{busy ? "Creating" : "Create invite"}</button>
      </form>
      <p className="banner ad-error" role="alert" hidden={!error}>{error}</p>
      <div className="state-note ad-result" id="invResult" role="status" hidden={!result}>
        {result ? (
          <>
            <p><b>Invite ready.</b> It is shown only once.</p>
            <code id="invLink" tabIndex={-1} ref={linkRef}>{result.link}</code>
            <button className="btn sm" type="button" id="invCopy" onClick={() => copy(result.link)}>Copy link</button>
            {result.warning ? <p className="ad-warn">{result.warning}</p> : null}
          </>
        ) : null}
      </div>
    </>
  );
}

/* ---------- people rows ---------- */
export function PersonRowActions({ id, role, on, label }: { id: number; role: "helper" | "organizer"; on: boolean; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function act(kind: "role" | "on") {
    if (busy) return;
    setBusy(true);
    const r = kind === "role"
      ? await post(`/api/team/accounts/${id}/role`, { role: role === "organizer" ? "helper" : "organizer" })
      : await post(`/api/team/accounts/${id}/status`, { status: on ? "off" : "on" });
    setBusy(false);
    if (!r.ok) { toast(String(r.data.message ?? "That did not work.")); return; }
    toast(kind === "role"
      ? `${label} is now ${role === "organizer" ? "a helper" : "an organizer"}. Their sessions ended, so they sign in again.`
      : on ? `${label} is signed out everywhere and cannot sign in.` : `${label} can sign in again.`);
    router.refresh();
  }
  return (
    <>
      <ConfirmModal
        label={role === "organizer" ? "Make helper" : "Make organizer"} who={label}
        title={`Make ${label} ${role === "organizer" ? "a helper" : "an organizer"}?`}
        line="Their sessions end, so they sign in again."
        confirm={role === "organizer" ? "Make helper" : "Make organizer"} disabled={busy} onConfirm={() => act("role")}
      />
      {on ? (
        <ConfirmModal
          label="Turn off" who={label} title={`Turn off ${label}?`}
          line="They are signed out everywhere and cannot sign in."
          confirm="Turn off" disabled={busy} onConfirm={() => act("on")}
        />
      ) : (
        <button className="txt-link" type="button" disabled={busy} onClick={() => act("on")}>Turn on<span className="vh">: {label}</span></button>
      )}
    </>
  );
}

/* ---------- invite rows ---------- */
export function InviteRowActions({ id, state }: { id: number; state: "pending" | "used" | "cancelled" | "expired" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const link = useSyncExternalStore(linkStore.sub, () => linkStore.get(id), () => null);

  async function cancel() {
    setBusy(true);
    const r = await post(`/api/team/invites/${id}/cancel`);
    setBusy(false);
    if (!r.ok) { toast(String(r.data.message ?? "That did not work.")); return; }
    toast("The invite is cancelled.");
    router.refresh();
  }
  async function again() {
    setBusy(true);
    const r = await post(`/api/team/invites/${id}/resend`);
    setBusy(false);
    if (!r.ok) { toast(String(r.data.message ?? "That did not work.")); return; }
    const inv = r.data.invite as { id: number };
    linkStore.set(inv.id, String(r.data.link));
    await copy(String(r.data.link));
    toast("A fresh link is ready and copied. The old one no longer works.");
    router.refresh();
  }

  if (state === "used") return null;
  if (state === "pending") {
    return (
      <>
        {link ? <button className="txt-link" type="button" onClick={() => copy(link)}>Copy link</button> : null}
        <ConfirmModal label="Cancel" title="Cancel this invite?" line="The link stops working." confirm="Cancel invite" keep="Keep invite" disabled={busy} onConfirm={cancel} />
        {link ? null : <button className="txt-link" type="button" disabled={busy} onClick={again} title="The link was shown once. This makes a new one.">Send again</button>}
      </>
    );
  }
  return <button className="txt-link" type="button" disabled={busy} onClick={again}>Send again</button>;
}
