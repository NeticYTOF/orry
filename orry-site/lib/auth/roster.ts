/* The second lock (decision L23): a person must be on Orry's roster, read with getDataSource().access().
   null means Orry could not be asked, and every caller must fail closed. Names are read from Slack at display time
   and kept in memory only (PLAN 6.7). */
import { getDataSource } from "../data";
import type { Person } from "../data/types";

export type RosterRole = "helper" | "organizer" | "public";

/** "public" = not on Orry's lists. null = cannot be checked right now. */
export async function rosterRole(slackId: string): Promise<RosterRole | null> {
  let a: { admin: boolean; helper: boolean } | null;
  try {
    a = await getDataSource().access(slackId);
  } catch {
    return null;
  }
  if (!a) return null;
  return a.admin ? "organizer" : a.helper ? "helper" : "public";
}

const NAME_TTL = 10 * 60 * 1000;
const G = globalThis as unknown as { __orryNames?: Map<string, { p: Person | null; at: number }> };
const names = (G.__orryNames ??= new Map());

/** The Slack name and handle for an ID, or a stand-in made from the ID when Slack cannot say. */
export async function personFor(slackId: string): Promise<Person & { known: boolean }> {
  const hit = names.get(slackId);
  let p: Person | null;
  if (hit && Date.now() - hit.at < NAME_TTL) p = hit.p;
  else {
    try { p = await getDataSource().getSlackUser(slackId); } catch { p = null; }
    names.set(slackId, { p, at: Date.now() });
  }
  return p ? { ...p, known: true } : { id: slackId, handle: slackId, name: slackId, known: false };
}

export async function peopleFor(ids: Array<string | null | undefined>): Promise<Map<string, Person & { known: boolean }>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, Person & { known: boolean }>();
  await Promise.all(uniq.map(async id => { out.set(id, await personFor(id)); }));
  return out;
}

export function clearNameCacheForTests(): void { names.clear(); }
