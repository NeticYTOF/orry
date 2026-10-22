/* Names for Slack IDs (PLAN 6.7, 4.17). One resolver through the data source (Core's users/info batch), cached in
   memory: hits fresh 24 h and usable up to 7 days while a refresh runs; confirmed misses 1 h; outage-shaped failures
   are never cached and the last good value is kept. Never an email. Names are never written to disk by this module. */
import { getDataSource } from "./data";
import type { DataSource, SlackUserInfo } from "./data/types";

/** What the UI renders for a person. Both forms are present; the root `data-people` attribute picks one with CSS. */
export type PersonRef = {
  id: string;
  /** Display name, then real name, then username; null when Slack could not say. */
  name: string | null;
  /** "@username" or null. */
  handle: string | null;
  /** The single best label: name, else handle, else "@U…". */
  label: string;
  /** For the square avatar fallback (first letter of the label). */
  initial: string;
  avatarUrl: string | null;
  /** false = Slack could not name this ID (no users:read, or unknown). */
  known: boolean;
  you: boolean;
};

const DAY = 86_400_000;
type Hit = { info: SlackUserInfo | null; at: number; miss: boolean };
const G = globalThis as unknown as { __orryPeople?: Map<string, Hit>; __orryPeopleInflight?: Map<string, Promise<void>> };
const cache = (G.__orryPeople ??= new Map());
const inflight = (G.__orryPeopleInflight ??= new Map());

export function personRef(id: string, info: SlackUserInfo | null | undefined, me?: string | null): PersonRef {
  const name = info?.displayName || info?.realName || info?.username || null;
  const handle = info?.username ? `@${info.username}` : null;
  const label = name ?? handle ?? `@${id}`;
  return { id, name, handle, label, initial: label.replace(/^@/, "").slice(0, 1).toUpperCase() || "?", avatarUrl: info?.avatarUrl ?? null, known: !!info, you: !!me && id === me };
}

async function refresh(ds: DataSource, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const key = batch.join(",");
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        try {
          const r = await ds.usersInfo(batch);
          const allNull = batch.every(id => !r[id]);
          const t = Date.now();
          for (const id of batch) {
            const info = r[id] ?? null;
            if (info) cache.set(id, { info, at: t, miss: false });
            else if (!allNull) cache.set(id, { info: null, at: t, miss: true }); // a confirmed miss
            // an all-null batch looks like an outage (missing scope, rate limit): keep the last good value
          }
        } catch { /* outage: keep what we have */ }
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    await p;
  }
}

/** Resolves Slack IDs to PersonRefs. `me` marks the signed-in person. */
export async function resolvePeople(ids: Iterable<string | null | undefined>, o: { me?: string | null; ds?: DataSource } = {}): Promise<Map<string, PersonRef>> {
  const ds = o.ds ?? getDataSource();
  const uniq = [...new Set([...ids].filter((x): x is string => !!x))];
  const now = Date.now();
  const need: string[] = [], background: string[] = [];
  for (const id of uniq) {
    const h = cache.get(id);
    if (!h) need.push(id);
    else if (h.miss ? now - h.at > 60 * 60_000 : now - h.at > DAY) (h.miss || now - h.at > 7 * DAY ? need : background).push(id);
  }
  if (need.length) await refresh(ds, need);
  if (background.length) void refresh(ds, background);
  const out = new Map<string, PersonRef>();
  for (const id of uniq) out.set(id, personRef(id, cache.get(id)?.info, o.me));
  return out;
}

export async function resolvePerson(id: string, o: { me?: string | null; ds?: DataSource } = {}): Promise<PersonRef> {
  return (await resolvePeople([id], o)).get(id)!;
}

/** True when the last answers for these IDs were all names (the "Names are not available" banner uses the opposite). */
export function namesAvailable(ids: string[]): boolean {
  return ids.length === 0 || ids.some(id => !!cache.get(id)?.info);
}

/** Sort by what is shown: names mode sorts by name, handle mode by handle. */
export const byLabel = (a: PersonRef, b: PersonRef): number => a.label.localeCompare(b.label);

export function clearPeopleCacheForTests(): void { cache.clear(); inflight.clear(); }
