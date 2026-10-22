/* Thin wrappers around other agents' modules so the view-models can be tested with stubs.
   - logEvent from lib/auth/events.ts (CORE): every ticket view and every reveal is logged (PLAN 2.4 rule 5).
   - Preferences: CORE does not publish a store for them yet, so "Show me on the leaderboard" lives behind this interface
     with an in-memory default. CORE can swap in a site.db-backed store with setPreferencesStore(). */
import { dataMode } from "../data";
import { NOAH_HIDDEN_BY_DEFAULT } from "./fixturePrefs";

export type LogFn = (kind: string, actorSlackId: string | null, o?: { subject?: string; reason?: string }) => void;

let logImpl: LogFn | null = null;
/** Defaults to CORE's logEvent, loaded lazily so tests without a database can stub it. */
export function setLogEvent(fn: LogFn | null): void { logImpl = fn; }
export async function logAccess(kind: "ticket_view" | "ticket_reveal", actor: string, ticketId: number): Promise<void> {
  const reason = `ticket ${ticketId}`;
  if (logImpl) return logImpl(kind, actor, { reason });
  const m = await import("../auth/events");
  m.logEvent(kind, actor, { reason });
}

export interface PreferencesStore {
  showOnLeaderboard(slackId: string): Promise<boolean>;
  setShowOnLeaderboard(slackId: string, show: boolean): Promise<void>;
  /** Slack IDs of people who chose to hide (for the leaderboard). */
  hiddenFromLeaderboard(): Promise<Set<string>>;
}

export class MemoryPreferences implements PreferencesStore {
  private hidden = new Set<string>();
  constructor(initialHidden: Iterable<string> = []) { for (const id of initialHidden) this.hidden.add(id); }
  async showOnLeaderboard(id: string) { return !this.hidden.has(id); }
  async setShowOnLeaderboard(id: string, show: boolean) { if (show) this.hidden.delete(id); else this.hidden.add(id); }
  async hiddenFromLeaderboard() { return new Set(this.hidden); }
}

const G = globalThis as unknown as { __orryPrefs?: PreferencesStore };
export function preferences(): PreferencesStore {
  /* The fixtures start with Noah Berg hidden, as leaderboard.html draws it. */
  return (G.__orryPrefs ??= new MemoryPreferences(dataMode() === "fixtures" ? NOAH_HIDDEN_BY_DEFAULT : []));
}
export function setPreferencesStore(p: PreferencesStore | null): void { G.__orryPrefs = p ?? undefined; }
