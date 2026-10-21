/* getBoardModel: the open tickets board (PLAN 4.1, K1-K12, mockup queue.html). Pages contain no metric logic. */
import { createHash } from "node:crypto";
import type { Session } from "../session";
import { getDataSource } from "../data";
import type { DataSource, ProgramConfig, TicketRow, WaitEstimate } from "../data/types";
import { DataError, isDataError } from "../data/types";
import { readDetail, readOpenSet, readParked, readProgram, readReopenInfo, readRoster, readWait, staffCandidates, withOrganizers, type ReopenInfo, type RosterInfo } from "../data/reads";
import { siteLimitMinutes, slackThreadUrl } from "../data/clock";
import { isOutsideChannels } from "../data/strip";
import { looksSensitive, SENSITIVE_BOARD_COPY } from "../data/sensitive";
import {
  ageBucket, hasNoOwner, headline as headlineOf, humanReplySince, isImported, isReleased, limitChip, load as loadOf, previousOwner,
  queueShape, STATUS_WORD, viewsOf, waitingSince, type BoardContext
} from "../metrics/board";
import { formatDuration, isoDuration, MIN } from "../metrics/time";
import { resolvePeople, personRef, type PersonRef } from "../people";
import { categoryLabel, freshnessOf, panelError, type Freshness } from "./shared";
import { excerpt, mentionIds, slackToPlain } from "./text";
import type { BoardModel, BoardQuery, BoardRow, BoardView } from "./boardTypes";

export type { BoardModel, BoardQuery, BoardRow, BoardView } from "./boardTypes";
export { rowsFor, facetCounts } from "./boardTypes";

const VIEW_DEFS: Array<{ key: BoardView; label: string; tabLabel: string; head: string | null }> = [
  { key: "human", label: "Needs a human", tabLabel: "Needs a human", head: null },
  { key: "noowner", label: "No owner", tabLabel: "No owner", head: null },
  { key: "mine", label: "Mine", tabLabel: "Mine", head: "Assigned to you automatically. No ping." },
  { key: "orry", label: "Answered by Orry or unconfirmed", tabLabel: "Orry or unconfirmed", head: "Never escalated: answered by Orry, or never confirmed." },
  { key: "48h", label: "Over 48 h", tabLabel: "Over 48 h", head: null },
  { key: "imp", label: "Imported", tabLabel: "Imported", head: "Made by Orry's history import. Hidden elsewhere." },
  { key: "parked", label: "Parked", tabLabel: "Parked", head: "Snoozed tickets never wake up in Orry." },
  { key: "all", label: "All open", tabLabel: "All open", head: null }
];
export const BOARD_VIEWS = VIEW_DEFS.map(v => v.key);

const SPRITE: Record<string, BoardRow["statusSprite"]> = { assigned: "people", claimed: "people", snoozed: "list", duplicate: "layers" };
const CLS: Record<string, BoardRow["statusClass"]> = { assigned: "quiet", claimed: "quiet", open: "dot", snoozed: "dot", duplicate: "dot" };

const ago = (ms: number) => (ms < MIN ? "just now" : `${formatDuration(ms)} ago`);

function emptyModel(s: Session, me: PersonRef, freshness: Freshness, error: BoardModel["error"], view: BoardView, limit: number): BoardModel {
  const shape = Object.fromEntries(BOARD_VIEWS.map(v => [v, []])) as unknown as BoardModel["queueShape"];
  return {
    generatedAt: new Date().toISOString(), version: "none", freshness, error, role: s.role, me, view, limitMinutes: limit,
    headline: { needHuman: 0, word: "need a human now", waitingFirstReply: 0, inProgress: 0, noOwner: 0, oldest: null, over: 0, near: 0, unknown: 0, limitLabel: `site limit ${formatDuration(limit * MIN)}`, limitSource: "site", typicalReply: null, filterNote: "" },
    views: VIEW_DEFS.map((v, i) => ({ ...v, count: 0, shortcut: i + 1 })), rows: [], load: [], queueShape: shape, categories: [], banners: [], empty: null, definitions: DEFINITIONS(limit)
  };
}

const DEFINITIONS = (limit: number): BoardModel["definitions"] => [
  { term: "Open", definition: "Status open, waiting for a helper, assigned, claimed, escalated or reopened. No time window." },
  { term: "Needs a human", definition: "Waiting for a helper, escalated, reopened, claimed or assigned, plus tickets released back to the queue." },
  { term: "Waiting since", definition: "When it was reopened, if it was. For a released ticket, its last change (so the wait is at least that long). Otherwise when it was opened." },
  { term: "Human reply", definition: "The first reply by a helper or organizer. Orry's own status message never counts." },
  { term: "No owner", definition: "Nobody is assigned, or it was reopened and nobody has taken it again." },
  { term: "Over the limit", definition: `Needs a human, waiting longer than ${formatDuration(limit * MIN, { nbsp: false })} since waiting since, with no human reply since then.` },
  { term: "Near the limit", definition: `The same, waiting longer than ${formatDuration(limit * MIN * 0.75, { nbsp: false })}.` },
  { term: "Imported", definition: "Made by Orry's history import (dashboard-only visibility). Hidden from the other views." }
];

/** The board for one signed-in person. Never throws: failures become the panel's state. */
export async function getBoardModel(s: Session, q: BoardQuery = {}, dsIn?: DataSource): Promise<BoardModel> {
  const ds = dsIn ?? getDataSource();
  const view: BoardView = BOARD_VIEWS.includes(q.view as BoardView) ? (q.view as BoardView) : "human";
  const limitMin = siteLimitMinutes();
  const limitMs = limitMin * MIN;
  const now = ds.now();
  const meFallback = personRef(s.slackId, { slackId: s.slackId, displayName: s.name, realName: null, username: s.handle, avatarUrl: null }, s.slackId);

  let open;
  try { open = await readOpenSet(ds); }
  catch (e) { return emptyModel(s, meFallback, freshnessOf(ds, null, isDataError(e) ? e : null), panelError(e, s.role), view, limitMin); }

  const [parkedR, programR, waitR, rosterR] = await Promise.allSettled([readParked(ds), readProgram(ds), readWait(ds), readRoster(ds)]);
  const program: ProgramConfig | null = programR.status === "fulfilled" ? programR.value.value : null;
  const rosterRead: RosterInfo = rosterR.status === "fulfilled" ? rosterR.value.value : { ids: new Set(), helpers: [], organizers: [] };
  const wait: WaitEstimate | null = waitR.status === "fulfilled" ? waitR.value.value : null;
  const parked: TicketRow[] = parkedR.status === "fulfilled" ? parkedR.value.value.rows : [];
  const freshness = freshnessOf(ds, open);
  const importDetection = !(program && (program.ticketVisibility === "dashboard" || program.publicTicketsEnabled === false));
  const channels = program?.channels ?? [];
  const isOrg = s.role === "organizer";

  // tickets outside the program's channels are organizer-only (PLAN 2.4 rule 16)
  const visible = (r: TicketRow) => isOrg || !isOutsideChannels(r.channel, channels);
  const openRows = open.value.rows.filter(visible);
  const parkedRows = parked.filter(visible);
  const roster = await withOrganizers(ds, rosterRead, staffCandidates(openRows));

  const reopen: Map<number, ReopenInfo> = await readReopenInfo(ds, openRows, roster.ids).catch(() => new Map());
  const ctx: BoardContext = { now, limitMs, me: s.slackId, reopen, importDetection };

  // who released a released ticket: the last "unclaimed" event (fixtures read it at once; the bridge only from cache)
  const releasedBy = new Map<number, string>();
  for (const r of openRows.filter(isReleased)) {
    try {
      if (ds.mode !== "fixtures") continue;
      const d = (await readDetail(ds, r.id)).value;
      const ev = d?.events.filter(e => e.event_type === "unclaimed").at(-1);
      if (ev?.actor_id) releasedBy.set(r.id, ev.actor_id);
    } catch { /* not shown */ }
  }

  const textRows = [...openRows, ...parkedRows];
  const ids = new Set<string>([s.slackId, ...roster.helpers, ...roster.organizers, ...releasedBy.values()]);
  for (const r of textRows) { if (r.assignee_id) ids.add(r.assignee_id); for (const m of mentionIds(r.question)) ids.add(m); }
  const people = await resolvePeople(ids, { me: s.slackId, ds }).catch(() => new Map<string, PersonRef>());
  const P = (id: string | null | undefined): PersonRef | null => (id ? people.get(id) ?? personRef(id, null, s.slackId) : null);
  const me = people.get(s.slackId) ?? meFallback;

  const autoAssigned = (r: TicketRow) => !!program?.autoAssign && r.status === "assigned" && r.claimed_at == null && r.assigned_at != null && r.assigned_at - r.created_at < 5 * MIN;

  const build = (r: TicketRow): BoardRow => {
    const released = isReleased(r);
    const ws = waitingSince(r);
    const waitMs = Math.max(0, now - ws.at);
    const chip = limitChip(r, ctx);
    const reply = humanReplySince(r, ctx);
    const reopenFacts = reopen.get(r.id);
    const statusKey = released ? "released" : r.status;
    const outside = isOutsideChannels(r.channel, channels);
    const sensitive = looksSensitive(r.question);
    let question: string | null = null, questionNote: string | null = null;
    if (outside) questionNote = "Outside Loadout's channels. Organizers only; the text is not shown.";
    else if (r.text_redacted_at) questionNote = r.text_redaction === "edited" ? "The participant edited this message in Slack. Open it there." : "The participant deleted this message in Slack.";
    else if (sensitive) questionNote = SENSITIVE_BOARD_COPY;
    else if (freshness.hideText || !r.question) questionNote = r.question ? "Hidden while Orry's data is old. Open in Slack to read it." : "No text stored.";
    else question = excerpt(slackToPlain(r.question, people));
    const ownerGone = hasNoOwner(r, ctx);
    const owner = ownerGone ? null : P(r.assignee_id);
    const prev = previousOwner(r, ctx);
    const flags: BoardRow["flags"] = [];
    if (now - r.created_at < 10 * MIN) flags.push({ key: "new", text: "New" });
    if (r.notes_count) flags.push({ key: "notes", text: `${r.notes_count} note${r.notes_count > 1 ? "s" : ""}` });
    if (autoAssigned(r)) flags.push({ key: "auto", text: "Auto-assigned, no ping" });
    if (isImported(r, ctx)) flags.push({ key: "imported", text: "Imported" });
    if (r.duplicate_of) flags.push({ key: "dup", text: `Duplicate of #${r.duplicate_of}` });
    if (r.card_ts) flags.push({ key: "card", text: "Card posted" });
    const humanReply: BoardRow["humanReply"] = r.reopened_at != null
      ? reply === true ? "since_reopen" : reply === "unknown" ? "unknown" : "none_since_reopen"
      : r.first_human_response_at != null ? "after" : "none";
    const humanReplyText = humanReply === "after" ? `after ${formatDuration(r.first_human_response_at! - r.created_at)}`
      : humanReply === "none_since_reopen" ? "None recorded since reopen"
      : humanReply === "since_reopen" ? "Since the reopen"
      : humanReply === "unknown" ? "Unknown since reopen" : "None yet";
    const limitText = chip === "over" ? `Over ${formatDuration(limitMs)}` : chip === "near" ? `Near ${formatDuration(limitMs * 0.75)}` : chip === "unknown" ? (reopenFacts?.truncated ? "Unknown: 100+ events" : "Unknown: not checked yet") : null;
    const limitNote = chip === "over" ? (r.reopened_at != null ? "No human reply recorded since the reopen." : "Waiting longer than the site limit with no human reply.")
      : chip === "near" ? `Waiting over ${formatDuration(limitMs * 0.75, { nbsp: false })} with no human reply; the limit is ${formatDuration(limitMs, { nbsp: false })}.`
      : chip === "unknown" ? (reopenFacts?.truncated ? "Reopened ticket with 100 or more events. Replies after the 100th event can't be seen." : "Reopened ticket. The site has not checked its events yet.") : null;
    const statusWord = statusKey === "reopened" && r.reopen_count > 1 ? `Reopened ×${r.reopen_count}` : STATUS_WORD[statusKey as keyof typeof STATUS_WORD] ?? r.status;
    return {
      id: r.id, href: `/tickets/${r.id}`, slackUrl: outside ? null : slackThreadUrl(r.channel, r.thread_ts),
      status: statusKey, statusWord, statusSprite: SPRITE[r.status] ?? "ticket", statusClass: released ? "" : CLS[r.status] ?? "",
      waitMs, waitText: formatDuration(waitMs), waitIso: isoDuration(waitMs), atLeast: ws.atLeast || freshness.state !== "live",
      limit: chip, limitText, limitNote,
      question, questionNote, sensitive,
      category: r.category ?? "other", categoryLabel: categoryLabel(r.category),
      humanReply, humanReplyText,
      lastChangeText: ago(Math.max(0, now - (r.updated_at ?? r.created_at))),
      flags,
      owner, ownerState: !owner ? "none" : owner.id === s.slackId ? "you" : "person",
      previousOwner: P(prev), releasedBy: released ? P(releasedBy.get(r.id)) : null,
      views: viewsOf(r, ctx),
      facets: { status: statusKey, category: r.category ?? "other", owner: owner ? owner.id : "_none", age: ageBucket(waitMs) },
      isNew: now - r.created_at < 10 * MIN,
      imported: isImported(r, ctx),
      sort: { wait: waitMs, id: r.id, status: statusWord, owner: owner ? (owner.id === s.slackId ? "0" : owner.label) : "~", category: categoryLabel(r.category), reply: r.first_human_response_at != null ? r.first_human_response_at - r.created_at : Number.MAX_SAFE_INTEGER, lastChange: r.updated_at ?? r.created_at }
    };
  };

  const rows = [...openRows, ...parkedRows].map(build).sort((a, b) => b.waitMs - a.waitMs || a.id - b.id);
  const h = headlineOf(openRows, ctx);
  const views = VIEW_DEFS.map((v, i) => ({ ...v, count: rows.filter(r => r.views.includes(v.key) && !(v.key === "all" && r.imported)).length, shortcut: i + 1 }));

  const loadItems = loadOf(openRows, ctx, roster.helpers).map(li => {
    const person = li.key === "_none" ? null : P(li.key);
    return {
      key: li.key, person, label: person ? person.label : "No owner", n: li.n,
      oldestText: li.oldestMs != null ? formatDuration(li.oldestMs) : null, over: li.over, you: li.key === s.slackId,
      line: li.n ? `oldest ${freshness.state !== "live" ? "≥ " : ""}${formatDuration(li.oldestMs!)}${li.over ? ` · ${li.over} over` : ""}` : "free"
    };
  });
  const loadSorted = [loadItems[0], ...loadItems.slice(1).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))].filter(Boolean);

  const queueShapes = Object.fromEntries(BOARD_VIEWS.map(v => [v, queueShape(openRows.filter(r => viewsOf(r, ctx).includes(v)).concat(v === "parked" ? parkedRows : []), ctx)])) as BoardModel["queueShape"];

  const banners: BoardModel["banners"] = [];
  if (program && !program.sla) banners.push({ key: "no_sla", text: `Over the limit uses the site's limit: ${formatDuration(limitMs, { nbsp: false })} to a first human reply. Orry has no limits set.` });
  if (program && !program.organizerChannel) banners.push({ key: "no_cards", text: "Ticket cards are off in Slack. Orry has no organizer channel, so this board is the only list of tickets." });
  if (!importDetection) banners.push({ key: "dashboard_visibility", text: "Orry is set to keep tickets on the dashboard only (ticketVisibility or publicTicketsEnabled), so every ticket looks imported. The site shows all of them." });
  if (rosterR.status === "fulfilled" && roster.ids.size === 0) banners.push({ key: "roster_empty", text: "Loadout's helper roster is empty, so the site can't tell who is a helper, and Orry doesn't record human replies." });
  if ([...people.values()].length > 1 && [...people.values()].every(p => !p.known)) banners.push({ key: "names", text: "Names are not available. Orry needs the users:read permission. Showing Slack IDs." });
  if (open.value.capped) banners.push({ key: "capped", text: "Only the oldest 1,000 open tickets are listed. The counts are still exact." });

  const typical = wait && wait.available ? { text: `about ${formatDuration(wait.medianWaitMs)}`, note: `7-day median, n ${wait.sampleSize}`, n: wait.sampleSize } : null;
  const nhRows = rows.filter(r => r.views.includes("human"));
  const empty: BoardModel["empty"] = h.openAll === 0 && parkedRows.length === 0
    ? { kind: "no_open", title: "No open tickets.", body: "Passt (all good).", links: [] }
    : nhRows.length === 0
      ? { kind: "nothing_needs_human", title: "Nothing needs a human.", body: `Last checked ${freshness.tag.replace(/^LIVE · /, "")}.`, links: (["orry", "imp"] as const).map(v => ({ view: v, label: v === "orry" ? "Answered by Orry or unconfirmed" : "Imported", count: views.find(x => x.key === v)!.count })).filter(l => l.count > 0) }
      : null;

  const version = createHash("sha1").update(JSON.stringify(rows.map(r => [r.id, r.status, r.owner?.id ?? "", r.limit ?? "", r.humanReply]))).digest("hex").slice(0, 16);

  return {
    generatedAt: new Date().toISOString(), version, freshness, error: null, role: s.role, me, view, limitMinutes: limitMin,
    headline: {
      needHuman: h.needHuman, word: h.needHuman === 1 ? "needs a human now" : "need a human now",
      waitingFirstReply: h.waitingFirstReply, inProgress: h.inProgress, noOwner: h.noOwner,
      oldest: h.oldest ? { id: h.oldest.id, href: `/tickets/${h.oldest.id}`, waitText: formatDuration(h.oldest.waitMs), waitIso: isoDuration(h.oldest.waitMs), atLeast: h.oldest.atLeast || freshness.state !== "live" } : null,
      over: h.over, near: h.near, unknown: h.unknown,
      limitLabel: `site limit ${formatDuration(limitMs)}`, limitSource: "site",
      typicalReply: typical,
      filterNote: "These numbers describe everything that needs a human, not the view or filters below."
    },
    views, rows: freshness.hideRows ? [] : rows, load: loadSorted, queueShape: queueShapes,
    categories: [...new Set(rows.map(r => r.category))].map(c => ({ key: c, label: categoryLabel(c) })),
    banners, empty, definitions: DEFINITIONS(limitMin)
  };
}

/* ---------- polling: "n changes" between two versions (the 30-second update model, PLAN 4.1 Live updates) ---------- */

type Snap = Map<number, { status: string; owner: string | null; human: boolean }>;
const G = globalThis as unknown as { __orryBoardSnaps?: Map<string, Snap> };
const snaps = (G.__orryBoardSnaps ??= new Map());

function snapshotOf(m: BoardModel): Snap {
  return new Map(m.rows.filter(r => r.views.includes("human") || r.views.includes("all")).map(r => [r.id, { status: r.status, owner: r.owner?.id ?? null, human: r.views.includes("human") }]));
}
export function rememberBoard(m: BoardModel): void {
  if (m.version === "none") return;
  snaps.set(m.version, snapshotOf(m));
  while (snaps.size > 50) snaps.delete(snaps.keys().next().value!);
}

export type BoardChanges = { total: number; added: number; claimed: number; left: number; other: number; text: string; announce: string | null };

/** Changes from the version the browser shows to the current model. null when that version is not known any more. */
export function boardChanges(sinceVersion: string, m: BoardModel): BoardChanges | null {
  const before = snaps.get(sinceVersion);
  if (!before) return null;
  const after = snapshotOf(m);
  let added = 0, claimed = 0, left = 0, other = 0, moreHuman = 0;
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) { added++; if (a.human) moreHuman++; continue; }
    if (a.owner && a.owner !== b.owner) claimed++;
    else if (a.status !== b.status) other++;
    if (a.human && !b.human) moreHuman++;
  }
  for (const id of before.keys()) if (!after.has(id)) left++;
  const total = added + claimed + left + other;
  const parts = [added && `${added} new`, claimed && `${claimed} claimed`, left && `${left} left`, other && `${other} changed`].filter(Boolean).join(", ");
  return {
    total, added, claimed, left, other,
    text: total ? `${total} change${total === 1 ? "" : "s"}: ${parts}. Press R or select Apply.` : "",
    announce: moreHuman ? `${moreHuman} more ticket${moreHuman === 1 ? "" : "s"} need${moreHuman === 1 ? "s" : ""} a human.` : null
  };
}

export { DataError };
