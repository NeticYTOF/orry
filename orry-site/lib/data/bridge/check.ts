/* The bridge check: BridgeSource and every view-model over one DataSource, as an organizer and as a helper.
   Used by scripts/bridge-check.ts against a live dev bridge, and by test/data-bridge-contract.test.ts against the
   responses that script recorded. Returns the headline numbers as plain JSON, so a replay can compare them.
   Never prints ticket text: only counts, ids, states and labels. */
import type { DataSource, TicketMeta } from "../types";
import { isDataError } from "../types";
import type { Session } from "../../session";
import { clearAllCaches } from "../cache";
import { readHistory, readProgram, readRoster } from "../reads";
import { looksSensitive } from "../sensitive";
import { isOutsideChannels } from "../strip";
import { eventLabel } from "../../metrics/finishedBy";
import { lastWeeks, parseWeek, shiftWeek, weekKey } from "../../metrics/time";
import { clearPeopleCacheForTests } from "../../people";
import { getBoardModel } from "../../models/board";
import { getTicketModel, revealTicket } from "../../models/ticket";
import { getStatsModel } from "../../models/stats";
import { getClosedModel } from "../../models/closed";
import { getMeModel, getLeaderboardModel } from "../../models/people";
import { MemoryPreferences, setLogEvent, setPreferencesStore } from "../../models/deps";
import type { PanelError } from "../../models/shared";

export type CheckLog = { line(s: string): void; fail(s: string): void; warn(s: string): void };

export const CHECK_ORGANIZER: Session = { accountId: 1, slackId: "U0PAT0001", role: "organizer", handle: "pat-placeholder", name: "Pat Placeholder" };
export const CHECK_HELPER: Session = { accountId: 2, slackId: "U0JUNO001", role: "helper", handle: "pixel-otter", name: "Juno Baker" };

export type CheckSummary = Record<string, unknown>;

export async function runBridgeChecks(ds: DataSource, log: CheckLog): Promise<{ now: number; summary: CheckSummary }> {
  clearAllCaches();
  clearPeopleCacheForTests();
  setPreferencesStore(new MemoryPreferences());
  const logged: Array<{ kind: string; actor: string | null; reason?: string; subject?: string }> = [];
  setLogEvent((kind, actor, o) => { logged.push({ kind, actor, ...o }); });
  const now = ds.now();
  const S: CheckSummary = {};
  const err = (where: string, e: unknown) => {
    if (isDataError(e)) {
      const msg = `${e.kind === "shape" ? "shape" : e.kind} on ${where} (route ${e.route ?? "?"}): ${e.message}`;
      if (e.kind === "shape" || e.kind === "unauthorized" || e.kind === "not_connected") log.fail(msg); else log.warn(msg);
    } else log.fail(`${where}: ${(e as Error)?.stack ?? String(e)}`);
  };
  const panel = (where: string, p: PanelError | null) => {
    if (!p) return;
    const msg = `${p.kind === "shape" ? "shape" : p.kind} in the ${where} model: ${p.message}${p.detail ? ` ${p.detail}` : ""}`;
    if (p.kind === "shape" || p.kind === "error") log.fail(msg); else log.warn(msg);
  };
  const tryIt = async <T>(where: string, f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch (e) { err(where, e); return null; } };

  /* ---------------- the source itself ---------------- */
  log.line("== BridgeSource");
  const health = await ds.health();
  log.line(`  health: ok ${health.ok}, open tickets ${health.openTickets}, names ${health.usersReadGranted}, ticket cards ${health.ticketCardsOn}, wait limit ${health.waitLimitMinutes} (${health.message})`);
  if (!health.ok) log.fail(`health: ${health.message}`);
  S.health = { ok: health.ok, openTickets: health.openTickets, ticketCardsOn: health.ticketCardsOn };

  const program = await tryIt("program", () => ds.program());
  if (program) log.line(`  program: ${program.name}, channels ${program.channels.join(", ")}, organizer channel ${program.organizerChannel}, visibility ${program.ticketVisibility}, autoAssign ${program.autoAssign}, sla ${program.sla ? "set" : "not set"}`);
  if (program && program.channels.length === 0) log.fail("program: no channels, so 'outside Loadout's channels' cannot be decided");
  S.program = program && { channels: program.channels, organizerChannel: program.organizerChannel, sla: program.sla };

  const access: Record<string, unknown> = {};
  for (const id of ["U0PAT0001", "U0JUNO001", "U0QUIN001", "U0KID0001"]) access[id] = await ds.access(id);
  log.line(`  access: ${Object.entries(access).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ")}`);
  if ((access.U0PAT0001 as { admin?: boolean } | null)?.admin !== true) log.fail("access: the organizer is not admin");
  if ((access.U0JUNO001 as { helper?: boolean } | null)?.helper !== true) log.fail("access: the helper is not on the roster");
  S.access = access;

  const roster = await tryIt("roster", () => ds.roster());
  if (roster) {
    const org = roster.filter(p => p.role === "organizer");
    log.line(`  roster: ${roster.length} people (${org.length} organizers: ${org.map(p => p.id).join(", ") || "none"}); first: ${roster[0] ? `${roster[0].name} @${roster[0].handle}` : "-"}`);
    if (!org.length) log.warn("roster: no organizers, so an organizer's own finishes are never credited");
    S.roster = roster.map(p => `${p.id}:${p.role}:${p.handle}:${p.name}`).sort();
  }

  const names = await tryIt("usersInfo", () => ds.usersInfo(["U0PAT0001", "U0JUNO001", "U0KID0001", "U0NOPE9999"]));
  if (names) {
    log.line(`  users/info: ${Object.entries(names).map(([k, v]) => `${k} ${v ? `${v.displayName}/${v.realName}/@${v.username}` : "null"}`).join(", ")}`);
    S.names = names;
  }
  const one = await tryIt("getSlackUser", () => ds.getSlackUser("U0LEILA01"));
  const byHandle = await tryIt("findSlackUserByHandle", () => ds.findSlackUserByHandle("@copper-wren"));
  const suggest = await tryIt("searchSlackUsers", () => ds.searchSlackUsers("co", 8));
  log.line(`  getSlackUser U0LEILA01: ${one ? `${one.name} @${one.handle}` : "null"}; by handle @copper-wren: ${byHandle?.id ?? "null"}; invite suggestions for "co": ${(suggest ?? []).map(p => `@${p.handle}`).join(", ") || "none"}`);
  if (!byHandle) log.fail("members route: @copper-wren was not found by handle (invite form)");
  if (!suggest?.length) log.fail("members route: no invite suggestions");
  S.people = { one, byHandle: byHandle?.id ?? null, suggest: (suggest ?? []).map(p => p.id) };

  const wait = await tryIt("waitEstimate", () => ds.waitEstimate());
  log.line(`  wait: ${JSON.stringify(wait)}`);
  S.wait = wait;

  const page = await tryIt("searchTickets", () => ds.searchTickets({ statusGroup: "open", sort: "waiting", limit: 200 }));
  if (page) log.line(`  open tickets: total ${page.total}, page ${page.rows.length}`);

  /* closings over the 12 weeks the history pages read */
  const cur = weekKey(now);
  const weeks = lastWeeks(cur, 12).map(k => parseWeek(k)!);
  const closings = await tryIt("closings", () => ds.closings(weeks[0].start, weeks.at(-1)!.end));
  if (closings) {
    const kinds: Record<string, number> = {};
    for (const c of closings) { const k = `${c.eventType ?? "none"}/${c.actorKind ?? "-"}${c.source ? `/${c.source}` : ""}${c.rule ? `/${c.rule}` : ""}${c.verdict ? "/judge" : ""}`; kinds[k] = (kinds[k] ?? 0) + 1; }
    log.line(`  closing route: ${closings.length} finished tickets in weeks ${weeks[0].key}..${cur}: ${Object.entries(kinds).sort().map(([k, n]) => `${k} ${n}`).join(", ")}`);
    S.closingKinds = kinds;
  } else log.fail("closing route: null (not deployed?)");

  /* row rule vs closing route: every finished ticket, both labels */
  const hist = await tryIt("history", () => readHistory(ds, weeks[0].start, weeks.at(-1)!.end));
  const rosterInfo = await tryIt("roster info", () => readRoster(ds));
  if (hist && rosterInfo) {
    const h = hist.value;
    const diff: Record<string, number> = {};
    let same = 0, missing = 0;
    for (const t of h.finished) {
      const c = h.closings?.get(t.id);
      if (!c) { missing++; continue; }
      const ev = eventLabel(c, t, rosterInfo.value.ids) ?? t.rowLabel;
      if (ev === t.rowLabel) same++;
      else { const k = `row ${t.rowLabel} -> closing ${ev}`; diff[k] = (diff[k] ?? 0) + 1; }
    }
    log.line(`  row rule vs closing route: ${same} agree, ${missing} finished rows with no closing row${Object.keys(diff).length ? `, differ: ${Object.entries(diff).map(([k, n]) => `${k} (${n})`).join("; ")}` : ""}`);
    if (missing) log.fail(`closing route: ${missing} finished tickets have no row on the closing route`);
    if (h.incomplete.size) log.warn(`history: ${h.incomplete.size} weeks marked incomplete: ${[...new Set(h.incomplete.values())].join("; ")}`);
    S.rowVsClosing = { same, missing, diff };
    S.history = { finished: h.finished.length, created: h.created.length, closings: h.closings?.size ?? null };
  }

  /* ---------------- the view-models ---------------- */
  const lastFull = shiftWeek(cur, -1);
  for (const s of [CHECK_ORGANIZER, CHECK_HELPER]) {
    const who = s.role;
    const R: Record<string, unknown> = {};
    log.line(`\n== As the ${who} (${s.slackId})`);

    const board = await tryIt("board", () => getBoardModel(s, { view: "human" }, ds));
    if (board) {
      panel("board", board.error);
      const hd = board.headline;
      log.line(`  board: ${hd.needHuman} ${hd.word}; first reply ${hd.waitingFirstReply}, in progress ${hd.inProgress}, no owner ${hd.noOwner}; over ${hd.over}, near ${hd.near}, unknown ${hd.unknown}; oldest #${hd.oldest?.id ?? "-"} ${hd.oldest?.waitText ?? ""}; typical reply ${hd.typicalReply?.text ?? "hidden"}`);
      log.line(`         ${board.rows.length} rows; views ${board.views.map(v => `${v.key} ${v.count}`).join(", ")}; banners ${board.banners.map(b => b.key).join(", ") || "none"}; freshness ${board.freshness.tag}`);
      log.line(`         load ${board.load.map(l => `${l.label} ${l.n}`).join(", ")}`);
      const sens = board.rows.filter(r => r.sensitive);
      for (const r of sens) if (r.question !== null) log.fail(`board (${who}): sensitive ticket #${r.id} shows its text`);
      for (const r of board.rows) if (r.question !== null && (r.slackUrl === null || /deleted|edited/.test(r.questionNote ?? ""))) log.fail(`board (${who}): #${r.id} shows text it must not`);
      const outside = board.rows.filter(r => r.slackUrl === null);
      if (who === "helper" && outside.length) log.fail(`board (helper): ${outside.length} rows outside Loadout's channels are visible`);
      log.line(`         ${sens.length} sensitive rows withheld; ${outside.length} rows outside Loadout's channels`);
      R.board = { needHuman: hd.needHuman, waitingFirstReply: hd.waitingFirstReply, inProgress: hd.inProgress, noOwner: hd.noOwner, limitFlags: hd.over + hd.near + hd.unknown, oldest: hd.oldest?.id ?? null, rows: board.rows.length, views: Object.fromEntries(board.views.map(v => [v.key, v.count])), banners: board.banners.map(b => b.key), sensitive: sens.map(r => r.id), outside: outside.map(r => r.id), load: board.load.map(l => `${l.key}:${l.n}`) };
    }

    for (const [label, week] of [["last full week", lastFull], ["current week", cur]] as const) {
      const st = await tryIt(`stats ${week}`, () => getStatsModel(s, { week, includeImported: false }, ds));
      if (!st) continue;
      panel(`stats ${week}`, st.error);
      const fb = st.finishedBy;
      log.line(`  stats ${week} (${label}): ${st.title}`);
      log.line(`         strip ${st.strip.map(i => `${i.key}=${i.value}`).join(" | ")}`);
      log.line(`         equation ${st.equation.resolved} resolved + ${st.equation.closed} closed = ${st.equation.finished} (import no answer ${st.equation.closedImportNoAnswer}); Orry ${fb.orry.total} (last word ${fb.orry.lastWord}, judge ${fb.orry.judge}, import ${fb.orry.historyImport}); people ${fb.people.total} (helpers ${fb.people.helpers}, participants ${fb.people.participants}, person or macro ${fb.people.personOrMacro}); exact ${fb.exact}`);
      log.line(`         team ${st.team.rows.map(r => `${r.person.label} ${r.finished}/${r.firstReplies}`).join(", ") || "none"}; totals ${st.team.totals.finished} finished, ${st.team.totals.firstReplies} first replies${st.incomplete ? `; incomplete: ${st.incomplete}` : ""}`);
      if (!fb.exact && st.equation.finished > 0) log.warn(`stats ${week}: the closing route did not decide every label`);
      R[`stats ${label}`] = { week, strip: Object.fromEntries(st.strip.map(i => [i.key, i.value])), equation: st.equation, orry: fb.orry, people: fb.people, exact: fb.exact, team: st.team.rows.map(r => `${r.person.id}:${r.finished}:${r.firstReplies}`), teamTotals: st.team.totals };
    }

    const closed = await tryIt("closed", () => getClosedModel(s, { week: lastFull }, ds));
    if (closed) {
      panel("closed", closed.error);
      log.line(`  closed ${lastFull}: ${closed.title}; counts ${JSON.stringify(closed.counts)}; ${closed.result}`);
      for (const r of closed.rows) if (r.question !== null && r.questionNote !== null) log.fail(`closed: #${r.id} has both text and a note`);
      const withheld = closed.rows.filter(r => r.question === null).map(r => `#${r.id} ${r.questionNote}`);
      if (withheld.length) log.line(`         withheld: ${withheld.join("; ")}`);
      R.closed = { counts: closed.counts, total: closed.total, withheld: closed.rows.filter(r => r.question === null).map(r => r.id), labels: Object.fromEntries(closed.rows.map(r => [r.id, r.label])) };
    }

    const me = await tryIt("me", () => getMeModel(s, ds));
    if (me) {
      panel("me", me.error);
      log.line(`  me: ${me.title}; finished ${me.strip.finished.value} of the team's ${me.strip.finished.team}; open ${me.strip.open.value}; median ${me.strip.median.value}; reopened ${me.strip.reopened.value} of ${me.strip.reopened.of}; on roster ${me.onRoster}; name ${me.me.name} ${me.me.handle}`);
      R.me = { finished: me.strip.finished.value, team: me.strip.finished.team, open: me.strip.open.value, median: me.strip.median.value, onRoster: me.onRoster, finishedRows: me.finished.length };
    }

    const lb = await tryIt("leaderboard", () => getLeaderboardModel(s, { period: "week" }, ds));
    if (lb) {
      panel("leaderboard", lb.error);
      log.line(`  leaderboard ${lb.periodLabel}: ${lb.title}; ${lb.rows.map(r => `${r.person.label} ${r.finished}`).join(", ")}; team ${lb.team.finished}`);
      R.leaderboard = { rows: lb.rows.map(r => `${r.person.id}:${r.finished}:${r.firstReplies}`), team: lb.team };
    }
    const lb8 = await tryIt("leaderboard 8w", () => getLeaderboardModel(s, { period: "8w" }, ds));
    if (lb8) { panel("leaderboard 8w", lb8.error); log.line(`  leaderboard ${lb8.periodLabel}: ${lb8.rows.map(r => `${r.person.label} ${r.finished}`).join(", ")}; team ${lb8.team.finished}`); R.leaderboard8w = { rows: lb8.rows.map(r => `${r.person.id}:${r.finished}`), team: lb8.team.finished }; }
    S[who] = R;
  }

  /* ---------------- tickets and the privacy rules ---------------- */
  log.line("\n== Tickets and privacy");
  const all: TicketMeta[] = hist ? [...hist.value.finished, ...hist.value.created] : [];
  const openRows = page?.rows ?? [];
  const rawById = new Map(openRows.map(r => [r.id, r]));
  const channels = (await readProgram(ds).catch(() => null))?.value.channels ?? [];
  const pick = {
    plain: openRows.find(r => !looksSensitive(r.question) && !r.text_redacted_at && !isOutsideChannels(r.channel, channels))?.id,
    sensitive: [...openRows.filter(r => looksSensitive(r.question)).map(r => r.id), ...all.filter(t => t.sensitive).map(t => t.id)][0],
    redacted: [...openRows, ...all].find(r => r.text_redacted_at)?.id,
    outside: [...openRows, ...all].find(r => isOutsideChannels(r.channel, channels))?.id,
    finished: hist?.value.finished.find(t => !t.sensitive && !t.text_redacted_at)?.id,
    reopened: openRows.find(r => r.reopened_at != null)?.id
  };
  log.line(`  picked: ${Object.entries(pick).map(([k, v]) => `${k} #${v ?? "none"}`).join(", ")}`);
  const T: Record<string, unknown> = { picked: pick };
  for (const [kind, id] of Object.entries(pick)) {
    if (id == null) { log.warn(`no ${kind} ticket in this data, so that path was not checked`); continue; }
    for (const s of [CHECK_ORGANIZER, CHECK_HELPER]) {
      const before = logged.length;
      const m = await tryIt(`ticket #${id}`, () => getTicketModel(s, id, ds));
      if (m === null) {
        log.line(`  #${id} (${kind}) as ${s.role}: not shown`);
        if (kind === "outside" && s.role === "organizer") log.fail(`ticket #${id} outside the channels is hidden from the organizer`);
        if (kind !== "outside") log.fail(`ticket #${id} (${kind}) is not shown to the ${s.role}`);
        T[`${kind}:${s.role}`] = null;
        continue;
      }
      panel(`ticket #${id}`, m.error);
      log.line(`  #${id} (${kind}) as ${s.role}: ${m.statusWord}, question ${m.question.state}${m.question.text ? ` (${m.question.text.length} chars)` : ""}; ${m.timeline.length} timeline + ${m.systemEvents.length} system events; ending ${m.ending ? `${m.ending.label}${m.ending.credited ? `, credited ${m.ending.credited.label}` : ""}` : "-"}`);
      T[`${kind}:${s.role}`] = { state: m.question.state, status: m.status, timeline: m.timeline.length, ending: m.ending?.label ?? null, credited: m.ending?.credited?.id ?? null };
      if (kind === "outside" && s.role === "helper") log.fail(`ticket #${id} outside the channels is visible to a helper`);
      if (kind === "sensitive" && (m.question.state !== "withheld_sensitive" || m.question.text !== null)) log.fail(`sensitive ticket #${id}: state ${m.question.state}`);
      if (kind === "redacted" && (m.question.state !== "redacted" || m.question.text !== null)) log.fail(`redacted ticket #${id}: state ${m.question.state}`);
      if (kind === "outside" && (m.question.state !== "withheld_outside" || m.slackUrl !== null)) log.fail(`outside ticket #${id}: state ${m.question.state}, slack link ${m.slackUrl}`);
      const views = logged.slice(before).filter(l => l.kind === "ticket_view");
      if (views.length !== 1) log.fail(`ticket #${id}: ${views.length} ticket_view log rows, expected 1`);
      const timelineText = JSON.stringify(m.timeline) + JSON.stringify(m.systemEvents);
      const raw = rawById.get(id);
      if (raw?.question && raw.question.length > 12 && timelineText.includes(raw.question.slice(0, 12))) log.fail(`ticket #${id}: question text in the timeline`);
    }
  }
  if (pick.sensitive != null) {
    const before = logged.length;
    const r = await revealTicket(CHECK_HELPER, pick.sensitive, ds);
    const rows = logged.slice(before);
    log.line(`  reveal #${pick.sensitive} as helper: ${r.ok ? `ok, ${r.text.length} chars, "${r.note}"` : r.reason}; log rows ${rows.map(l => `${l.kind} ${l.reason}`).join(", ")}`);
    if (!r.ok) log.fail(`reveal of #${pick.sensitive} failed: ${r.reason}`);
    if (!rows.some(l => l.kind === "ticket_reveal")) log.fail("reveal wrote no ticket_reveal log row");
    T.reveal = r.ok ? { ok: true, chars: r.text.length } : r;
  }
  for (const k of ["redacted", "outside", "plain"] as const) {
    const id = pick[k];
    if (id == null) continue;
    const r = await revealTicket(CHECK_HELPER, id, ds);
    if (r.ok) log.fail(`reveal of the ${k} ticket #${id} returned text`);
  }
  /* log rows carry the ticket number only, never text */
  const leaks = logged.filter(l => l.reason && !/^ticket \d+$/.test(l.reason));
  if (leaks.length) log.fail(`access log rows with more than the ticket number: ${leaks.length}`);
  log.line(`  access log rows written: ${logged.length} (${[...new Set(logged.map(l => l.kind))].join(", ")}), all "ticket N" only: ${leaks.length === 0}`);
  S.tickets = T;
  S.logKinds = [...new Set(logged.map(l => l.kind))].sort();
  setLogEvent(null);
  return { now, summary: S };
}

