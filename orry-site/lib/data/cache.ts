/* Short in-memory caches with single-flight and a last good copy for the Stale state (PLAN 6.4, 6.5).
   Nothing here is ever written to disk. Entries that hold participants' text have the text removed once they are
   older than `textMaxMs` (10 minutes by default), and the numbers stay until restart. */
import { DataError, isDataError } from "./types";

export type Read<T> = {
  value: T;
  fetchedAt: number;      // real clock, ms
  stale: boolean;         // served from the last good copy after a failed refresh
  error: DataError | null;
  textDropped: boolean;
};

type Entry<T> = { value: T; at: number; textDropped: boolean };

export type CacheOpts<T> = {
  ttlMs: number;
  /** Removes text from a value. Required for caches that hold ticket text. */
  dropText?: (v: T) => T;
  /** Text is dropped this long after the fetch (fresh or stale). Default 10 minutes. */
  textMaxMs?: number;
};

const G = globalThis as unknown as { __orryCaches?: Set<MemoCache<unknown>> };
const ALL = (G.__orryCaches ??= new Set());

export class MemoCache<T> {
  private entries = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<Read<T>>>();
  constructor(readonly name: string, private readonly o: CacheOpts<T>, private readonly clock: () => number = Date.now) {
    ALL.add(this as MemoCache<unknown>);
  }

  private expireText(e: Entry<T>): void {
    if (!this.o.dropText || e.textDropped) return;
    if (this.clock() - e.at >= (this.o.textMaxMs ?? 10 * 60_000)) { e.value = this.o.dropText(e.value); e.textDropped = true; }
  }

  /** Fresh value from cache, or one shared call to `load`. On failure, the last good copy marked stale; else throws. */
  async get(key: string, load: () => Promise<T>): Promise<Read<T>> {
    const e = this.entries.get(key);
    if (e) this.expireText(e);
    if (e && this.clock() - e.at < this.o.ttlMs) return { value: e.value, fetchedAt: e.at, stale: false, error: null, textDropped: e.textDropped };
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async (): Promise<Read<T>> => {
      try {
        const value = await load();
        const at = this.clock();
        this.entries.set(key, { value, at, textDropped: false });
        return { value, fetchedAt: at, stale: false, error: null, textDropped: false };
      } catch (err) {
        const de = isDataError(err) ? err : new DataError("error", "The data could not be read.");
        const last = this.entries.get(key);
        // a shape mismatch or a config problem is never hidden behind old numbers
        if (last && (de.kind === "offline" || de.kind === "timeout" || de.kind === "rate_limited" || de.kind === "error")) {
          this.expireText(last);
          return { value: last.value, fetchedAt: last.at, stale: true, error: de, textDropped: last.textDropped };
        }
        throw de;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  peek(key: string): Entry<T> | undefined {
    const e = this.entries.get(key);
    if (e) this.expireText(e);
    return e;
  }
  set(key: string, value: T): void { this.entries.set(key, { value, at: this.clock(), textDropped: false }); }
  delete(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); this.inflight.clear(); }
  sweep(): void { for (const e of this.entries.values()) this.expireText(e); }
  /** Keys only (for tests). */
  keys(): string[] { return [...this.entries.keys()]; }
}

/** Tests and source swaps. */
export function clearAllCaches(): void { for (const c of ALL) c.clear(); }

/* text expiry runs even when nobody reads a cache */
const T = globalThis as unknown as { __orrySweep?: ReturnType<typeof setInterval> };
if (!T.__orrySweep && typeof setInterval === "function") {
  T.__orrySweep = setInterval(() => { for (const c of ALL) c.sweep(); }, 60_000);
  (T.__orrySweep as { unref?: () => void }).unref?.();
}
