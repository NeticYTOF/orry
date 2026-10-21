/* The bridge client (server only; PLAN 6.2 rules, 6.4 controls). Written fresh for the site.
   - An allow-list of routes: GET only, plus POST /internal/v1/slack/users/info. There is no generic proxy.
   - programId is fixed to "loadout" in the paths below; every query value is whitelisted and clamped.
   - The token comes from RIVET_INTERNAL_READ_TOKEN, else RIVET_INTERNAL_TOKEN, read at call time and never logged.
     With neither set, no Authorization header is sent (the forwarding proxy of PLAN 6.2 injects it).
   - Single-flight per route key, at most 2 calls in flight, 30 calls a minute, 5 s timeout (15 s for a names batch),
     and a circuit breaker that opens for 60 s after 3 failures in a row. */
import type { z } from "zod";
import { DataError } from "../types";

if (typeof window !== "undefined") throw new Error("The bridge client must never be bundled for the browser.");

export type RouteName = "health" | "programs" | "search" | "detail" | "wait" | "sla" | "helpers" | "access" | "closing" | "members" | "usersInfo";

type RouteDef = { method: "GET" | "POST"; re: RegExp; params: Record<string, (v: unknown) => string | null>; gap?: string };

const int = (lo: number, hi: number) => (v: unknown) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? String(Math.min(Math.max(n, lo), hi)) : null;
};
const ms = (v: unknown) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n >= 0 && n < 8.64e15 ? String(n) : null; };
const oneOf = (...xs: string[]) => (v: unknown) => (typeof v === "string" && xs.includes(v) ? v : null);
const slackId = (v: unknown) => (typeof v === "string" && /^[UW][A-Z0-9]{2,20}$/.test(v) ? v : null);

const STATUSES = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened", "resolved", "closed", "snoozed", "duplicate", "waiting_for_user"];

export const ROUTES: Record<RouteName, RouteDef> = {
  health: { method: "GET", re: /^\/internal\/v1\/health$/, params: {} },
  programs: { method: "GET", re: /^\/internal\/v1\/programs$/, params: {} },
  search: {
    method: "GET", re: /^\/internal\/v1\/programs\/loadout\/tickets\/search$/,
    params: { status: oneOf(...STATUSES), statusGroup: oneOf("open", "resolved"), since: ms, until: ms, sort: oneOf("created", "updated", "waiting"), limit: int(1, 200), offset: int(0, 100_000) }
  },
  detail: { method: "GET", re: /^\/internal\/v1\/programs\/loadout\/tickets\/\d{1,9}$/, params: { eventsLimit: int(1, 200) } },
  wait: { method: "GET", re: /^\/internal\/v1\/programs\/loadout\/wait$/, params: {} },
  sla: { method: "GET", re: /^\/internal\/v1\/programs\/loadout\/sla$/, params: {} },
  helpers: { method: "GET", re: /^\/internal\/v1\/programs\/loadout\/helpers$/, params: {} },
  access: { method: "GET", re: /^\/internal\/v1\/programs\/loadout\/access$/, params: { userId: slackId }, gap: "G27" },
  closing: { method: "GET", re: /^\/internal\/v1\/programs\/loadout\/tickets\/closing$/, params: { since: ms, until: ms, limit: int(1, 500), offset: int(0, 100_000) }, gap: "G9" },
  members: { method: "GET", re: /^\/internal\/v1\/programs\/loadout\/members$/, params: { channel: v => (typeof v === "string" && /^[CG][A-Z0-9]{2,20}$/.test(v) ? v : null) }, gap: "the members route" },
  usersInfo: { method: "POST", re: /^\/internal\/v1\/slack\/users\/info$/, params: {} }
};

export type BridgeStats = Record<string, { calls: number; failures: number; lastMs: number | null; p95Ms: number | null; lastError: string | null }>;

export type ClientOptions = {
  baseUrl?: () => string | undefined;
  token?: () => string | undefined;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  perMinute?: number;
};

export class BridgeClient {
  private inflight = new Map<string, Promise<unknown>>();
  private active = 0;
  private waiters: Array<() => void> = [];
  private bucket: { tokens: number; at: number };
  private failures = 0;
  private openUntil = 0;
  private stats = new Map<string, { calls: number; failures: number; lat: number[]; lastError: string | null }>();
  private readonly baseUrl: () => string | undefined;
  private readonly token: () => string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly perMinute: number;

  constructor(o: ClientOptions = {}) {
    this.baseUrl = o.baseUrl ?? (() => process.env.RIVET_CORE_BASE_URL);
    this.token = o.token ?? (() => process.env.RIVET_INTERNAL_READ_TOKEN || process.env.RIVET_INTERNAL_TOKEN || undefined);
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.clock = o.clock ?? Date.now;
    this.perMinute = o.perMinute ?? 30;
    this.bucket = { tokens: this.perMinute, at: this.clock() };
  }

  configured(): boolean { return !!this.baseUrl()?.trim(); }

  /** Per-route latency and failure counts (route names only, never paths with IDs or queries). */
  bridgeStats(): BridgeStats {
    const out: BridgeStats = {};
    for (const [k, s] of this.stats) {
      const sorted = [...s.lat].sort((a, b) => a - b);
      out[k] = { calls: s.calls, failures: s.failures, lastMs: s.lat.at(-1) ?? null, p95Ms: sorted.length ? sorted[Math.ceil(0.95 * sorted.length) - 1] : null, lastError: s.lastError };
    }
    return out;
  }

  private take(cost: number): boolean {
    const t = this.clock();
    this.bucket.tokens = Math.min(this.perMinute, this.bucket.tokens + ((t - this.bucket.at) / 60_000) * this.perMinute);
    this.bucket.at = t;
    if (this.bucket.tokens < cost) return false;
    this.bucket.tokens -= cost;
    return true;
  }
  private async slot(): Promise<() => void> {
    if (this.active >= 2) await new Promise<void>(r => this.waiters.push(r));
    this.active++;
    return () => { this.active--; this.waiters.shift()?.(); };
  }
  private record(route: string, ok: boolean, latency: number | null, err?: string): void {
    const s = this.stats.get(route) ?? { calls: 0, failures: 0, lat: [], lastError: null };
    s.calls++;
    if (!ok) { s.failures++; s.lastError = err ?? "error"; }
    if (latency != null) { s.lat.push(latency); if (s.lat.length > 50) s.lat.shift(); }
    this.stats.set(route, s);
  }

  /**
   * Calls an allow-listed route and validates the body with `schema`.
   * `allow404` returns null for a plain 404 (e.g. "ticket not found") instead of throwing.
   */
  async call<S extends z.ZodTypeAny>(route: RouteName, path: string, o: { query?: Record<string, unknown>; body?: unknown; schema: S; allow404?: boolean; cost?: number; timeoutMs?: number }): Promise<z.output<S> | null> {
    const def = ROUTES[route];
    if (!def.re.test(path)) throw new Error(`bridge: path not on the allow-list for ${route}`);
    if (def.method === "GET" && o.body !== undefined) throw new Error("bridge: GET routes take no body");
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined || v === null) continue;
      const check = def.params[k];
      if (!check) throw new Error(`bridge: parameter ${k} is not allowed on ${route}`);
      const clean = check(v);
      if (clean !== null) qs.set(k, clean);
    }
    const key = `${def.method} ${path}?${qs.toString()}${o.body !== undefined ? " " + JSON.stringify(o.body) : ""}`;
    const running = this.inflight.get(key);
    if (running) return running as Promise<z.output<S> | null>;
    const p = this.run(route, def, path, qs, o).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run<S extends z.ZodTypeAny>(route: RouteName, def: RouteDef, path: string, qs: URLSearchParams, o: { body?: unknown; schema: S; allow404?: boolean; cost?: number; timeoutMs?: number }): Promise<z.output<S> | null> {
    const base = this.baseUrl()?.trim().replace(/\/+$/, "");
    if (!base) throw new DataError("not_connected", "No bridge address is set (RIVET_CORE_BASE_URL).", route);
    if (this.clock() < this.openUntil) throw new DataError("offline", "Orry did not answer the last 3 calls. Trying again in a minute.", route);
    if (!this.take(o.cost ?? 1)) throw new DataError("rate_limited", "The site's own limit of calls to Orry was reached.", route);
    const release = await this.slot();
    const started = this.clock();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 5_000);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      const token = this.token();
      if (token) headers.authorization = `Bearer ${token}`;
      if (o.body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await this.fetchImpl(`${base}${path}${qs.size ? "?" + qs.toString() : ""}`, {
          method: def.method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined, signal: ctrl.signal, cache: "no-store", redirect: "error"
        });
      } catch (e) {
        const timedOut = (e as { name?: string })?.name === "AbortError";
        this.fail(route, timedOut ? "timeout" : "offline");
        throw new DataError(timedOut ? "timeout" : "offline", timedOut ? "Orry took too long to answer." : "Orry could not be reached.", route);
      }
      const latency = this.clock() - started;
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      const err = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
      if (res.status === 404 && err === "internal api disabled") { this.ok(route, latency); throw new DataError("not_connected", "Orry's data bridge is switched off. Its owner needs to set RIVET_INTERNAL_TOKEN.", route); }
      if (res.status === 401) { this.ok(route, latency); throw new DataError("unauthorized", "The site's bridge token doesn't match Orry's.", route); }
      if (res.status === 404 && o.allow404 && (err === "ticket not found" || err === "unknown program")) { this.ok(route, latency); return null; }
      if (res.status === 404 && def.gap) { this.ok(route, latency); throw new DataError("needs_update", `Not available yet: needs Orry update ${def.gap}.`, route, def.gap); }
      if (res.status >= 500) { this.fail(route, `status ${res.status}`); throw new DataError("error", "Orry answered with an error.", route); }
      if (!res.ok) { this.ok(route, latency); throw new DataError("error", `Orry refused the request (${res.status}).`, route); }
      const parsed = o.schema.safeParse(body);
      if (!parsed.success) { this.ok(route, latency); this.record(route, false, null, "shape"); throw new DataError("shape", "Orry's answer did not have the expected shape. This Orry version may not be supported yet.", route); }
      this.ok(route, latency);
      return parsed.data;
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  private ok(route: string, latency: number): void { this.failures = 0; this.record(route, true, latency); }
  private fail(route: string, why: string): void {
    this.failures++;
    this.record(route, false, null, why);
    if (this.failures >= 3) { this.openUntil = this.clock() + 60_000; this.failures = 0; }
  }
}
