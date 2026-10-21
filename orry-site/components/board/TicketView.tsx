"use client";
/* The ticket, as the board's pane / modal and as the full page /tickets/[id] (PLAN 4.2; redesign spec "Board and ticket").
   Markup from TicketModel, shared by the server page and the board's dialog. A fixed header (category, number, status,
   wait, previous / next, More, Close); a body that scrolls on its own with the question pinned on top and three tabs
   under it (Details | Timeline | Notes); a fixed footer with the one action, Reply in Slack. The board passes tab and
   onTab so the chosen tab survives J / K; the page keeps it locally. Sensitive text is never in the model;
   RevealQuestion asks for it. CSS: app/ui/ticket.css (tk-). */
import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { TicketModel } from "@/lib/models";
import { CopyLink } from "./CopyLink";
import { LimitChip, StatusChip } from "./chips";
import { Person } from "./people";
import { RevealQuestion } from "./RevealQuestion";

const hhmm = (iso: string) => (iso ? `${iso.slice(11, 16)} UTC` : "");

/** Where this ticket sits in the list the board is showing, so the dialog can step through it. */
export type TicketNav = { pos: number; total: number; onPrev: (() => void) | null; onNext: (() => void) | null };
export type TicketTab = "details" | "timeline" | "notes";
const TABS: TicketTab[] = ["details", "timeline", "notes"];

function Question({ t }: { t: TicketModel }) {
  const q = t.question;
  const who = q.requester ? (q.requester.handle ?? q.requester.label) : null;
  const caption = [who, q.where, hhmm(q.at)].filter(Boolean).join(" · ");
  if (q.state === "withheld_sensitive" && q.revealPath) {
    return <RevealQuestion path={q.revealPath} note={q.note ?? "Sensitive topic."} caption={caption} safeguarding={q.safeguardingNote} textId={`qText${t.id}`} />;
  }
  return (
    <figure className={"tk-quote" + (q.state === "shown" ? "" : " withheld")}>
      <blockquote><p id={`qText${t.id}`}>{q.state === "shown" ? q.text : q.note}</p></blockquote>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function Timeline({ t }: { t: TicketModel }) {
  const [sys, setSys] = useState(false);
  const items = [
    ...t.timeline.map(e => ({ ...e, sys: false })),
    ...(sys ? t.systemEvents.map(e => ({ ...e, sys: true })) : [])
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return (
    <>
      {t.systemEvents.length ? (
        <div className="tk-tl-tools">
          <button className="btn sm" type="button" aria-pressed={sys} onClick={() => setSys(s => !s)}>
            {sys ? "Hide" : "Show"} system events <span className="tk-n">{t.systemEvents.length}</span>
          </button>
        </div>
      ) : null}
      {items.length ? (
        <ol className="tk-tl">
          {items.map((e, i) => (
            <li key={i} className={e.sys ? "sys" : undefined}>
              <small><time dateTime={e.at}>{e.timeUtc} UTC</time>{e.sys ? " · system" : ""}</small>
              <span>{e.text}</span>
            </li>
          ))}
        </ol>
      ) : <p className="tk-none">No events yet.</p>}
    </>
  );
}

export function TicketView({ t, mode, onClose, nav, tab: tabProp, onTab }: {
  t: TicketModel; mode: "sheet" | "page"; onClose?: () => void; nav?: TicketNav; tab?: TicketTab; onTab?: (t: TicketTab) => void;
}) {
  const [own, setOwn] = useState<TicketTab>("details");
  const tab = tabProp ?? own;
  const setTab = (k: TicketTab) => { setOwn(k); onTab?.(k); };
  const uid = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const Title = mode === "page" ? "h1" : "h2";
  const H = mode === "page" ? "h2" : "h3";

  const head = (
    <header className="tk-head">
      <p className="kicker tk-kick">{t.categoryLabel}</p>
      <div className="tk-tools">
        {nav ? (
          <div className="tk-step" role="group" aria-label="Move between tickets">
            <button className="btn sm icon" type="button" onClick={nav.onPrev ?? undefined} disabled={!nav.onPrev} aria-label="Previous ticket" aria-keyshortcuts="k" title="Previous ticket (K)">‹</button>
            <span className="tk-pos" aria-live="polite">{nav.pos} of {nav.total}</span>
            <button className="btn sm icon" type="button" onClick={nav.onNext ?? undefined} disabled={!nav.onNext} aria-label="Next ticket" aria-keyshortcuts="j" title="Next ticket (J)">›</button>
          </div>
        ) : null}
        <details className="menu tk-more">
          <summary className="btn sm" aria-label={`More actions for ticket ${t.id}`}>More <span className="ar" aria-hidden="true">▾</span></summary>
          <div className="menu-pop">
            <CopyLink id={t.id} />
            {t.cardUrl ? <a className="btn sm" href={t.cardUrl} target="_blank" rel="noopener noreferrer">Open card in the organizer channel <span className="ar" aria-hidden="true">↗</span></a> : null}
            {mode === "sheet" ? <a className="btn sm" href={t.href}>Open as a page</a> : null}
          </div>
        </details>
        {onClose ? <button className="btn sm" type="button" onClick={onClose} aria-label={`Close ticket ${t.id}`} aria-keyshortcuts="Escape">Close</button> : null}
      </div>
      <Title className="tk-title" id="shTitle" tabIndex={-1}>Ticket <span className="num">#{t.id}</span></Title>
      <div className="tk-sub">
        <StatusChip status={t.status} word={t.statusWord} />
        <LimitChip limit={t.limit} text={t.limitText} />
        {t.waitText ? <span className="tk-wait"><span className="kicker">Waiting</span> <time dateTime={t.waitIso ?? undefined}>{t.atLeast ? "≥ " : ""}{t.waitText}</time></span> : null}
      </div>
    </header>
  );

  if (t.error) {
    return (
      <>
        {head}
        <div className="tk-body">
          <div className="state-note" role="alert"><p>{t.error.message}</p>{t.error.detail ? <p>{t.error.detail}</p> : null}</div>
        </div>
      </>
    );
  }

  const label: Record<TicketTab, string> = { details: "Details", timeline: "Timeline", notes: "Notes" };
  const count: Record<TicketTab, number | null> = { details: null, timeline: t.timeline.length, notes: t.notes.length };
  /* the WAI-ARIA tabs pattern: one tab in the Tab order, arrows / Home / End move and select */
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    const to = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(TABS[to]);
    tabRefs.current[TABS[to]]?.focus();
  };
  const tid = (k: TicketTab) => `${uid}-tab-${k}`;
  const pid = (k: TicketTab) => `${uid}-panel-${k}`;

  return (
    <>
      {head}
      <div className="tk-body">
        {t.freshness.banner ? <p className="banner" role="status">{t.freshness.banner}</p> : null}
        <section className="tk-q" aria-labelledby={`q${t.id}`}>
          <H className="vh" id={`q${t.id}`}>The question</H>
          <Question t={t} />
        </section>

        <div className="tabs tk-tabs" role="tablist" aria-label={`Ticket ${t.id}`}>
          {TABS.map(k => (
            <button key={k} type="button" role="tab" id={tid(k)} aria-controls={pid(k)} aria-selected={tab === k} tabIndex={tab === k ? 0 : -1}
              ref={el => { tabRefs.current[k] = el; }} onClick={() => setTab(k)} onKeyDown={onTabKey}>
              {label[k]}{count[k] != null ? <span className="n">{count[k]}</span> : null}
            </button>
          ))}
        </div>

        <div className="tk-panel" role="tabpanel" id={pid(tab)} aria-labelledby={tid(tab)} tabIndex={0}>
          {tab === "details" ? (
            <div className="tk-details">
              <section className="tk-sec" aria-labelledby={`f${t.id}`}>
                <H className="tk-h" id={`f${t.id}`}>Key facts</H>
                <dl className="kv">
                  {t.facts.map(f => <div key={f.key}><dt>{f.term}</dt><dd>{f.value}{f.sub ? <small>{f.sub}</small> : null}</dd></div>)}
                </dl>
              </section>
              {t.ending || t.suggestions ? (
                <div className="tk-aside">
                  {t.ending ? (
                    <section className="tk-sec" aria-labelledby={`e${t.id}`}>
                      <H className="tk-h" id={`e${t.id}`}>How it ended</H>
                      <dl className="kv">
                        <div><dt>Finished by</dt><dd>{t.ending.byOrry ? <><b>ORRY</b>{t.ending.rule ? <small>{t.ending.rule}</small> : null}</> : t.ending.person ? <><Person p={t.ending.person} /><small>{t.ending.label}</small></> : t.ending.label}</dd></div>
                        {t.ending.credited ? <div><dt>Credited</dt><dd><Person p={t.ending.credited} /></dd></div> : null}
                        <div><dt>Finished</dt><dd>{t.ending.atText}</dd></div>
                      </dl>
                    </section>
                  ) : null}
                  {t.suggestions ? (
                    <section className="tk-sec" aria-labelledby={`w${t.id}`}>
                      <H className="tk-h" id={`w${t.id}`}>Who could take it</H>
                      <ol className="sugg">{t.suggestions.people.map(s => <li key={s.person.id}><b><Person p={s.person} /></b><span>{s.reason}</span></li>)}</ol>
                    </section>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : tab === "timeline" ? (
            <Timeline t={t} />
          ) : (
            t.notes.length
              ? <div className="tk-notes">{t.notes.map((n, i) => <div className="note" key={i}><small><Person p={n.author} /> · {n.timeUtc}</small>{n.body}</div>)}</div>
              : <p className="tk-none">No notes yet.</p>
          )}
        </div>
      </div>
      <footer className="tk-foot">
        {t.slackUrl
          ? <a className="btn pri" href={t.slackUrl} target="_blank" rel="noopener noreferrer">Reply in Slack <span className="ar" aria-hidden="true">↗</span></a>
          : <p>This ticket has no Slack link.</p>}
      </footer>
    </>
  );
}
