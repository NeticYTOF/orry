/* Origin checks, the return-path rule, security headers and the small in-memory rate limits (PLAN 7.2 step 7, 7.4). */
import { baseOrigin, hcaConfig } from "./auth/config";
import { isReturnablePage } from "./auth/routes";

type HeaderLike = { get(name: string): string | null };

/**
 * Every non-GET request must come from the site itself: Origin equals the exact base URL origin.
 * Browsers send "Origin: null" on form posts under Referrer-Policy: no-referrer, so a null or missing Origin
 * is accepted only when the browser also says Sec-Fetch-Site: same-origin.
 */
export function originAllowed(h: HeaderLike, expected = baseOrigin()): boolean {
  const origin = h.get("origin");
  if (origin && origin !== "null") return origin === expected;
  return h.get("sec-fetch-site") === "same-origin";
}

/**
 * A return path is accepted only if it is relative, starts with a single "/", has no "//" or backslash,
 * no control characters, and is a signed-in page on the route list. Anything else becomes /board.
 */
export function safeReturnPath(p: unknown, fallback = "/board"): string {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return fallback;
  if (!p.startsWith("/") || p.startsWith("//")) return fallback;
  if (p.includes("\\") || p.includes("//")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(p)) return fallback;
  if (/%(2f|5c|00)/i.test(p)) return fallback;
  let u: URL;
  try { u = new URL(p, "http://site.invalid"); } catch { return fallback; }
  if (u.origin !== "http://site.invalid") return fallback;
  if (!isReturnablePage(u.pathname)) return fallback;
  return u.pathname + u.search;
}

/* ---------------- headers ---------------- */

export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  const hca = hcaConfig();
  const formTargets = ["'self'", ...(hca ? [new URL(hca.issuer).origin] : [])];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    /* style attributes come from the mockup markup and React; style elements are ours */
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://avatars.slack-edge.com https://a.slack-edge.com https://secure.gravatar.com",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${formTargets.join(" ")}`,
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'none'"
  ].join("; ");
}

export function securityHeaders(nonce: string, o: { dev: boolean; https: boolean }): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(nonce, o.dev),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), xr-spatial-tracking=(), interest-cohort=()",
    "Cache-Control": "no-store, private"
  };
  /* no preload on a shared domain */
  if (o.https) h["Strict-Transport-Security"] = "max-age=31536000";
  return h;
}

/* ---------------- rate limits (per process) ---------------- */

type Bucket = { tokens: number; at: number };
const G = globalThis as unknown as { __orryBuckets?: Map<string, Bucket> };
const buckets = (G.__orryBuckets ??= new Map());

/** Token bucket: `rate` per second, at most `burst`. Returns false when the request should be refused. */
export function takeToken(key: string, rate: number, burst: number, t = Date.now()): boolean {
  const b = buckets.get(key) ?? { tokens: burst, at: t };
  b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * rate);
  b.at = t;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
export function resetRateLimitsForTests(): void { buckets.clear(); }
